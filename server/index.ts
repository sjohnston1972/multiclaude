import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { WebSocketServer, WebSocket } from "ws";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { SessionManager } from "./sessionManager.js";
import { readState, writeState, rememberFolder } from "./stateStore.js";
import { registerLauncherRoutes } from "./launcher.js";
import { pruneOldImages, registerImageRoutes } from "./images.js";

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
const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 });

// ---------------------------------------------------------------------------
// Cross-origin defence. Binding to loopback stops other machines, but NOT
// other websites: a browser will happily open a cross-origin WebSocket, so a
// malicious page you visit could otherwise connect to /ws and spawn a shell
// on this machine. We therefore require the WS Origin to be one of our own
// loopback origins (CLI tools send no Origin, which we allow), and the Host
// header to be loopback (this also defeats DNS-rebinding attacks).
const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[?::1\]?)(:\d+)?$/i;

function isAllowedWsRequest(req: { headers: Record<string, unknown> }): boolean {
  const host = String(req.headers["host"] ?? "");
  if (!LOOPBACK_HOST_RE.test(host)) return false;

  const origin = req.headers["origin"];
  if (origin === undefined) return true; // non-browser client (test scripts, curl)
  try {
    return LOOPBACK_HOST_RE.test(new URL(String(origin)).host);
  } catch {
    return false;
  }
}

// Same cross-origin rule for the REST API (defence-in-depth: JSON bodies
// already force a CORS preflight the browser blocks, but this also covers
// any future endpoint and simple GETs).
app.addHook("onRequest", async (req, reply) => {
  if (!isAllowedWsRequest(req)) {
    reply.code(403).send({ error: "Cross-origin request refused" });
  }
});

// In production (`npm run build` then `npm start`) the server also serves the
// built web UI. In dev, Vite serves the UI on :5173 and proxies to us instead.
const webDist = path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  app.register(fastifyStatic, { root: webDist });
}

// ---------------------------------------------------------------------------
// REST API: sessions
// ---------------------------------------------------------------------------

app.get("/api/health", async () => ({
  ok: true,
  shell: sessions.shellFriendly,
  pid: process.pid,
  uptimeSeconds: Math.round(process.uptime()),
  sessions: sessions.list(),
}));

app.get("/api/sessions", async () => sessions.list());

// Workspace restore: sessions that were alive when the server last stopped and
// aren't running now. The browser offers to bring them back on load.
app.get("/api/sessions/restorable", async () => sessions.restorableSpecs());

app.post("/api/sessions/restore", async () => sessions.restore().map((s) => sessions.info(s)));

app.post("/api/sessions/restore/dismiss", async () => {
  sessions.dismissRestore();
  return { ok: true };
});

app.post("/api/sessions", async (req, reply) => {
  const body = (req.body ?? {}) as {
    cwd?: string;
    autoClaude?: boolean;
    worktree?: string | null;
    skipPermissions?: boolean;
  };
  let cwd: string | undefined;
  if (body.cwd) {
    const resolved = path.resolve(body.cwd);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      reply.code(400);
      return { error: `Folder doesn't exist: ${resolved}` };
    }
    cwd = resolved;
    rememberFolder(resolved);
  }

  // "Auto-start claude" types `claude` into the fresh shell; the worktree
  // option makes it `claude --worktree <name>` so parallel sessions on the
  // same repo don't collide.
  let initialCommand: string | undefined;
  if (body.autoClaude) {
    const flags = body.skipPermissions ? " --dangerously-skip-permissions" : "";
    if (body.worktree) {
      if (!/^[A-Za-z0-9._-]{1,50}$/.test(body.worktree)) {
        reply.code(400);
        return { error: "Worktree name may only contain letters, numbers, dots, dashes" };
      }
      initialCommand = `claude --worktree ${body.worktree}${flags}`;
    } else {
      initialCommand = `claude${flags}`;
    }
  }

  try {
    const session = sessions.create({ cwd, initialCommand });
    return sessions.info(session);
  } catch (err) {
    reply.code(500);
    return { error: `Couldn't start ${sessions.shellFriendly}: ${(err as Error).message}` };
  }
});

// Used on reattach: if the server restarted and the pty is gone, respawn a
// shell with the same id in the same folder the tab remembers.
app.post("/api/sessions/:id/ensure", async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { cwd?: string };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    reply.code(400);
    return { error: "Invalid session id" };
  }
  const cwd = body.cwd && fs.existsSync(body.cwd) ? body.cwd : undefined;
  try {
    const { session, created } = sessions.ensure(id, cwd);
    return { ...sessions.info(session), created };
  } catch (err) {
    reply.code(500);
    return { error: `Couldn't start ${sessions.shellFriendly}: ${(err as Error).message}` };
  }
});

// Broadcast a command to every live session. Presses Enter after it unless
// enter:false (used for control sequences like Ctrl-C).
app.post("/api/broadcast", async (req) => {
  const body = (req.body ?? {}) as { command?: string; enter?: boolean };
  const command = typeof body.command === "string" ? body.command : "";
  const enter = body.enter !== false;
  const count = sessions.writeAll(`${command}${enter ? "\r" : ""}`);
  return { ok: true, sent: count };
});

// Kill everything at once (all kills run in parallel, responds when done).
app.delete("/api/sessions", async () => {
  const ids = sessions.list().map((s) => s.id);
  await Promise.all(ids.map((id) => sessions.kill(id)));
  return { ok: true, killed: ids.length };
});

app.delete("/api/sessions/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  // Resolves once the process has actually exited, so the client's next
  // session list is accurate immediately.
  const found = await sessions.kill(id);
  if (!found) reply.code(404);
  return { ok: found };
});

// ---------------------------------------------------------------------------
// REST API: persisted state (layout, settings, recent folders)
// ---------------------------------------------------------------------------

registerLauncherRoutes(app);
registerImageRoutes(app);
pruneOldImages();
// Prune again daily so a long-running (autostarted) server doesn't hoard images.
setInterval(pruneOldImages, 24 * 60 * 60 * 1000).unref();

app.get("/api/state", async () => readState());

app.put("/api/state", async (req) => {
  const body = (req.body ?? {}) as {
    layout?: unknown;
    settings?: { fontSize?: number; scrollback?: number };
  };
  const state = readState();
  if (body.layout !== undefined) state.layout = body.layout;
  if (body.settings) {
    if (typeof body.settings.fontSize === "number") {
      state.settings.fontSize = Math.min(32, Math.max(8, body.settings.fontSize));
    }
    if (typeof body.settings.scrollback === "number") {
      state.settings.scrollback = Math.min(200_000, Math.max(200, body.settings.scrollback));
    }
  }
  writeState(state);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// WebSocket: one connection per attached terminal pane.
// Client → server: {type:"input", data} | {type:"resize", cols, rows}
// Server → client: {type:"ready", shell} | {type:"output", data} | {type:"exit", code}
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws: WebSocket, sessionId: string) => {
  let session;
  try {
    session = sessions.ensure(sessionId).session;
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
    // Reject cross-origin / non-loopback WebSocket attempts before spawning
    // anything — see isAllowedWsRequest above.
    if (!isAllowedWsRequest(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
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
  sessions.flushManifest(); // persist the current sessions so they can be restored
  sessions.killAll();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Backstop: for a local single-user tool, a logged survivor beats a silent
// death. Log stray errors and keep the server (and everyone's sessions) up
// rather than letting one bad async throw take everything down.
process.on("uncaughtException", (err) => {
  console.error("multiclaude: uncaught exception (server kept running):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("multiclaude: unhandled rejection (server kept running):", reason);
});

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
