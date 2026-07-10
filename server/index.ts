import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { WebSocketServer, WebSocket } from "ws";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { SessionManager } from "./sessionManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Safety: this app spawns real shells. It must only ever listen on loopback.
// ---------------------------------------------------------------------------
const HOST = process.env.MULTICLAUDE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.MULTICLAUDE_PORT ?? 3001);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
if (!LOOPBACK_HOSTS.has(HOST)) {
  if (process.env.MULTICLAUDE_UNSAFE_HOST === "1") {
    console.warn("");
    console.warn("############################################################");
    console.warn("##  WARNING: multiclaude is binding to a NON-LOOPBACK     ##");
    console.warn(`##  address (${HOST}). Anyone who can reach this          `);
    console.warn("##  port gets a SHELL ON THIS MACHINE. Make sure you      ##");
    console.warn("##  understand exactly who can reach it.                  ##");
    console.warn("############################################################");
    console.warn("");
  } else {
    console.error(
      `Refusing to start: MULTICLAUDE_HOST=${HOST} is not a loopback address.\n` +
        `This app gives anyone who can connect a shell on this machine.\n` +
        `Set MULTICLAUDE_UNSAFE_HOST=1 only if you really mean to do this.`
    );
    process.exit(1);
  }
}

const sessions = new SessionManager();
const app = Fastify({ logger: false });

// In production (`npm run build` then `npm start`) the server also serves the
// built web UI. In dev, Vite serves the UI on :5173 and proxies to us instead.
const webDist = path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  app.register(fastifyStatic, { root: webDist });
}

app.get("/api/health", async () => ({
  ok: true,
  shell: sessions.shellFriendly,
  sessions: sessions.list().map((s) => ({
    id: s.id,
    pid: s.pty.pid,
    cwd: s.cwd,
    createdAt: s.createdAt,
  })),
}));

// ---------------------------------------------------------------------------
// WebSocket: one connection per attached terminal pane.
// Client → server: {type:"input", data} | {type:"resize", cols, rows}
// Server → client: {type:"ready", shell} | {type:"output", data} | {type:"exit", code}
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws: WebSocket, sessionId: string) => {
  let session;
  try {
    session = sessions.ensure(sessionId);
  } catch (err) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: `Couldn't start ${sessions.shellFriendly}: ${(err as Error).message}`,
      })
    );
    ws.close();
    return;
  }

  const { scrollback, detach } = sessions.attach(
    sessionId,
    (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    },
    (code) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", code }));
        ws.close();
      }
    }
  );

  ws.send(JSON.stringify({ type: "ready", shell: sessions.shellFriendly }));
  if (scrollback.length > 0) {
    ws.send(JSON.stringify({ type: "output", data: scrollback }));
  }

  ws.on("message", (raw) => {
    let msg: { type?: string; data?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "input" && typeof msg.data === "string") {
      sessions.write(sessionId, msg.data);
    } else if (
      msg.type === "resize" &&
      typeof msg.cols === "number" &&
      typeof msg.rows === "number"
    ) {
      sessions.resize(sessionId, msg.cols, msg.rows);
    }
  });

  ws.on("close", detach);
});

async function main() {
  await app.listen({ host: HOST, port: PORT });

  // Attach the WebSocket server to Fastify's HTTP server for /ws?session=<id>
  app.server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const sessionId = url.searchParams.get("session") ?? "default";
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, sessionId);
    });
  });

  console.log(`multiclaude server listening on http://${HOST}:${PORT}`);
  console.log(`shell: ${sessions.shellFriendly}`);
}

// Clean shutdown: kill child shells so we don't leave orphaned PowerShell
// processes behind.
function shutdown() {
  console.log("\nshutting down — killing sessions...");
  sessions.killAll();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
