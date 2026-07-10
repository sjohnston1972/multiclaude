import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";

type ConnState = "connecting" | "connected" | "disconnected" | "exited";

/**
 * One terminal pane = one xterm.js instance + one WebSocket to the server.
 * The WebSocket is like a console session: if it drops (browser refresh,
 * server restart), we reconnect and the server replays recent output.
 */
export default function TerminalPane({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ConnState>("connecting");
  const [statusMsg, setStatusMsg] = useState("Connecting…");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: 14,
      scrollback: 10000,
      theme: {
        background: "#0a0a0a",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        selectionBackground: "#264f78",
      },
    });
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

    const connect = () => {
      if (disposed || sessionExited) return;
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
        let msg: { type: string; data?: string; code?: number; shell?: string; message?: string };
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
          setStatusMsg("The shell exited. Refresh the page to start a new one.");
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
          /* clipboard permission denied — selection still works via Ctrl+C in browser */
        });
      }
    });

    // When the pane changes size in the browser, refit xterm and tell the pty.
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      sendResize();
    });
    resizeObserver.observe(container);

    term.focus();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      resizeObserver.disconnect();
      dataSub.dispose();
      selSub.dispose();
      ws?.close();
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full p-1" />
      {state !== "connected" && statusMsg && (
        <div className="absolute left-1/2 top-2 -translate-x-1/2 rounded bg-neutral-800 px-3 py-1 text-sm text-neutral-200 shadow">
          {statusMsg}
        </div>
      )}
    </div>
  );
}
