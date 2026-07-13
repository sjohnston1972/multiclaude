// Verifies the AutonomousManager skeleton (Step 2): spawn one invocation against
// the fake-claude stub, buffer its events, and transition running → done.
// Deterministic — no real claude, no tokens. Run with:
//
//     npx tsx scripts/manager-spawn-test.ts

import path from "node:path";
import { fileURLToPath } from "node:url";
import { AutonomousManager } from "../server/autonomous/manager.js";
import type { AutonomousState } from "../server/autonomous/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stub = path.join(__dirname, "_stub", "fake-claude.mjs");

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};

const states: AutonomousState[] = [];
let liveEvents = 0;

const mgr = new AutonomousManager({
  cwd: __dirname,
  // Test seam: run the stub via node instead of the real claude binary.
  spawn: { command: process.execPath, args: [stub] },
});
mgr.onState((s) => states.push(s));
mgr.onEvent(() => liveEvents++);

check("session UUID pinned at construction", /^[0-9a-f-]{36}$/.test(mgr.sessionId), mgr.sessionId);
check("starts in preflight", mgr.getState() === "preflight");

await mgr.start();

check("state went running → done", states[0] === "running" && mgr.getState() === "done", states.join("→"));
check("buffered ≥1 event", mgr.getEvents().length >= 1, `got ${mgr.getEvents().length}`);
check("live event listener fired", liveEvents >= 1, `got ${liveEvents}`);

const kinds = mgr.getEvents().map((e) => e.kind);
check("saw a result event", kinds.includes("result"), kinds.join(","));
check("events are sequentially numbered", mgr.getEvents().every((e, i) => e.seq === i));

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
