// Verifies the autonomous WebSocket stream (Step 8): on attach a client gets
// `ready`, then a `replay` of buffered events, then live `event`/`status`
// messages. Uses a real ephemeral server (inject can't do WebSockets), the
// fake-claude stub, and the shared attachAutonomousViewer helper.
// Run with:  npx tsx scripts/autonomous-ws-test.ts

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { AutonomousManager, attachAutonomousViewer } from "../server/autonomous/manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stub = path.join(__dirname, "_stub", "fake-claude.mjs");

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-ws-"));
fs.writeFileSync(path.join(dir, "PLAN.md"), "1. do a thing\n");
fs.writeFileSync(path.join(dir, "PROGRESS.md"), "## Blockers\n");

// A run that keeps producing events (ok scenario loops; short turn delay).
process.env.STUB_SCENARIO = "ok";
const manager = new AutonomousManager({
  cwd: dir,
  turnDelayMs: 80,
  spawn: { command: process.execPath, args: [stub] },
});
void manager.start();

const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws) => attachAutonomousViewer(ws, manager));
server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, "")));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

// Let a turn or two buffer some events before we attach, so `replay` is non-empty.
await sleep(300);

const messages: Array<{ type: string; events?: unknown[] }> = [];
const client = new WebSocket(`ws://127.0.0.1:${port}/ws/autonomous?tab=x`);
client.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
await new Promise<void>((r) => client.on("open", () => r()));

// Collect live traffic across at least one more turn boundary.
await sleep(400);

const liveEventCount = messages.filter((m) => m.type === "event").length;
check("first message is ready", messages[0]?.type === "ready", messages[0]?.type);
const replay = messages.find((m) => m.type === "replay");
check("a replay message with buffered events", !!replay && (replay!.events?.length ?? 0) >= 1, JSON.stringify(replay?.events?.length));
check("replay comes before any live event", messages.findIndex((m) => m.type === "replay") < (messages.findIndex((m) => m.type === "event") === -1 ? Infinity : messages.findIndex((m) => m.type === "event")));
check("received ≥1 live event after attach", liveEventCount >= 1, `live=${liveEventCount}`);
check("received a live status message", messages.some((m) => m.type === "status"));

client.close();
manager.stop();
await new Promise<void>((r) => wss.close(() => r()));
await new Promise<void>((r) => server.close(() => r()));
await sleep(200);
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  /* OS reaps temp later */
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
