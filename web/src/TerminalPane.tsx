import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import type { TabNode } from "flexlayout-react";

type ConnState = "connecting" | "connected" | "disconnected" | "exited";

/**
 * One terminal pane = one xterm.js instance + one WebSocket to the server.
 * The WebSocket is like a console session: if it drops (browser refresh,
 * server restart), we reconnect and the server replays recent output.
 * Before connecting we POST /ensure so a session that died with the server
 * is respawned in the same working directory this tab remembers.
 */
export default function TerminalPane({
  sessionId,
  cwd,
  node,
  fontSize = 14,
  scrollback = 10000,
}: {
  sessionId: string;
  cwd?: string;
  node?: TabNode;
  fontSize?: number;
  scrollback?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ConnState>("connecting");
  const [statusMsg, setStatusMsg] = useState("Connecting…");
  const [notice, setNotice] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = (msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize,
      scrollback,
      theme: {
        background: "#0a0a0a",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        selectionBackground: "#264f78",
      },
    });
    termRef.current = term;
    const fit = new FitAddon();
    const search = new SearchAddon();
    searchRef.current = search;
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(container);
    fit.fit();

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let sessionExited = false;

    const sendResize = () => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };

    const connect = async () => {
      if (disposed || sessionExited) return;

      // Make sure the session exists server-side (respawns it after a server
      // restart, in the folder this tab remembers).
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/ensure`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? "server error");
        }
      } catch (err) {
        if (disposed) return;
        setState("disconnected");
        setStatusMsg(
          err instanceof TypeError
            ? "Can't reach the multiclaude server — retrying…"
            : `Couldn't start the shell: ${(err as Error).message}`
        );
        reconnectTimer = setTimeout(connect, 2000);
        return;
      }
      if (disposed) return;

      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws?session=${encodeURIComponent(sessionId)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setState("connected");
        setStatusMsg("");
        // Tell the shell its real window size straight away — terminal apps
        // (Claude Code especially) render badly without this.
        sendResize();
      };

      ws.onmessage = (ev) => {
        let msg: { type: string; data?: string; code?: number; message?: string };
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === "output" && msg.data) {
          term.write(msg.data);
        } else if (msg.type === "exit") {
          sessionExited = true;
          setState("exited");
          setStatusMsg("The shell exited — close this tab, or refresh to restart it.");
        } else if (msg.type === "error" && msg.message) {
          setStatusMsg(msg.message);
        }
      };

      ws.onclose = () => {
        if (disposed || sessionExited) return;
        setState("disconnected");
        setStatusMsg("Connection lost — reconnecting…");
        reconnectTimer = setTimeout(connect, 1500);
      };
    };
    connect();

    // Keystrokes (including pasted text — xterm handles bracketed paste) go
    // straight down the socket to the shell.
    const dataSub = term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    // Copy-on-select, like a classic PowerShell window.
    const selSub = term.onSelectionChange(() => {
      const selection = term.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection).catch(() => {
          /* clipboard permission denied — not fatal */
        });
      }
    });

    // App-level shortcuts must not reach the shell: search + explicit copy
    // are handled here; new-tab / cycle-tabs bubble up to the window handler.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.ctrlKey && e.shiftKey && e.code === "KeyF") {
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.code === "KeyT") return false; // window handler opens dialog
      if (e.ctrlKey && e.code === "Tab") return false; // window handler cycles panes
      return true;
    });

    // Image paste & drop: upload to the server, then type the quoted file
    // path into the shell so Claude Code can read the image itself.
    const uploadImage = async (blob: Blob) => {
      showNotice("Uploading image…");
      try {
        const res = await fetch("/api/images", {
          method: "POST",
          headers: { "content-type": blob.type },
          body: blob,
        });
        const j = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
        if (!res.ok || !j.path) throw new Error(j.error ?? "upload failed");
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data: `"${j.path}" ` }));
        }
        showNotice("Image saved — path typed into the terminal");
      } catch (err) {
        showNotice(`Couldn't upload the image: ${(err as Error).message}`);
      }
    };

    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            void uploadImage(file);
            return;
          }
        }
      }
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files?.length) return;
      const image = [...files].find((f) => f.type.startsWith("image/"));
      if (image) {
        e.preventDefault();
        void uploadImage(image);
      }
    };
    container.addEventListener("paste", onPaste);
    container.addEventListener("dragover", onDragOver);
    container.addEventListener("drop", onDrop);

    // Only apply a fit when cols/rows actually change — refitting on every
    // pixel-level container change makes the scrollbar flap on and off.
    let fitQueued = false;
    const fitIfChanged = () => {
      fitQueued = false;
      if (disposed) return;
      // Skip while hidden (flexlayout keeps hidden tabs mounted at zero size).
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      const dims = fit.proposeDimensions();
      if (dims && (dims.cols !== term.cols || dims.rows !== term.rows)) {
        fit.fit();
        sendResize();
      }
    };
    fitRef.current = fitIfChanged;
    const resizeObserver = new ResizeObserver(() => {
      if (!fitQueued) {
        fitQueued = true;
        requestAnimationFrame(fitIfChanged);
      }
    });
    resizeObserver.observe(container);

    // When this tab becomes visible again (tab switch, layout change), refit
    // and grab keyboard focus.
    node?.setEventListener("visibility", (p: { visible: boolean }) => {
      if (p.visible) {
        requestAnimationFrame(() => {
          fitIfChanged();
          term.focus();
        });
      }
    });

    term.focus();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      node?.removeEventListener("visibility");
      container.removeEventListener("paste", onPaste);
      container.removeEventListener("dragover", onDragOver);
      container.removeEventListener("drop", onDrop);
      resizeObserver.disconnect();
      dataSub.dispose();
      selSub.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Apply settings changes to the live terminal without recreating it.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    term.options.scrollback = scrollback;
    fitRef.current?.();
  }, [fontSize, scrollback]);

  const closeSearch = () => {
    setSearchOpen(false);
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  };

  return (
    <div className="relative h-full w-full bg-[#0a0a0a]">
      {/* No padding here: the fit addon measures this element, and padding
          makes it size the terminal too large, causing scrollbar flicker. */}
      <div ref={containerRef} className="h-full w-full overflow-hidden" />

      {searchOpen && (
        <div className="absolute right-3 top-2 z-20 flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 p-1 shadow-lg">
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.shiftKey) searchRef.current?.findPrevious(searchQuery);
              else if (e.key === "Enter") searchRef.current?.findNext(searchQuery);
              else if (e.key === "Escape") closeSearch();
            }}
            placeholder="Search… (Enter next, Shift+Enter prev)"
            className="w-56 rounded bg-neutral-800 px-2 py-1 text-sm text-neutral-100 outline-none"
          />
          <button
            onClick={() => searchRef.current?.findPrevious(searchQuery)}
            className="rounded px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-700"
            title="Previous match (Shift+Enter)"
          >
            ↑
          </button>
          <button
            onClick={() => searchRef.current?.findNext(searchQuery)}
            className="rounded px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-700"
            title="Next match (Enter)"
          >
            ↓
          </button>
          <button
            onClick={closeSearch}
            className="rounded px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-700"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
      )}

      {state !== "connected" && statusMsg && (
        <div className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded bg-neutral-800 px-3 py-1 text-sm text-neutral-200 shadow">
          {statusMsg}
        </div>
      )}
      {notice && (
        <div className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded bg-neutral-800 px-3 py-1 text-sm text-neutral-200 shadow">
          {notice}
        </div>
      )}
    </div>
  );
}
