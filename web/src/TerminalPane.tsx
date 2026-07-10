import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
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
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);

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
    term.loadAddon(fit);
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
      node?.removeEventListener("visibility");
      resizeObserver.disconnect();
      dataSub.dispose();
      selSub.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
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

  return (
    <div className="relative h-full w-full bg-[#0a0a0a]">
      {/* No padding here: the fit addon measures this element, and padding
          makes it size the terminal too large, causing scrollbar flicker. */}
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
      {state !== "connected" && statusMsg && (
        <div className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded bg-neutral-800 px-3 py-1 text-sm text-neutral-200 shadow">
          {statusMsg}
        </div>
      )}
    </div>
  );
}
