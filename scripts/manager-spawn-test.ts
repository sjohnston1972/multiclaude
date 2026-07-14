// Verifies the AutonomousManager (Steps 2-3): spawn against the fake-claude stub,
// buffer events, and — with the supervisor loop — reach `done` when a DONE file
// appears. Deterministic; no real claude, no tokens. Run with:
//
//     npx tsx scripts/manager-spawn-test.ts

import fs from "node:fs";
import os from "node:os";
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

// A repo the integrity guard is happy with: PLAN.md + PROGRESS.md present.
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mc-mgr-"));
fs.writeFileSync(path.join(cwd, "PLAN.md"), "1. do a thing\n");
fs.writeFileSync(path.join(cwd, "PROGRESS.md"), "## Blockers\n");

const states: AutonomousState[] = [];
let liveEvents = 0;

const prevScenario = process.env.STUB_SCENARIO;
process.env.STUB_SCENARIO = "done"; // one turn writes DONE → loop stops at `done`

const mgr = new AutonomousManager({
  cwd,
  turnDelayMs: 5,
  spawn: { command: process.execPath, args: [stub] },
});
mgr.onState((s) => states.push(s));
mgr.onEvent(() => liveEvents++);

check("session UUID pinned at construction", /^[0-9a-f-]{36}$/.test(mgr.sessionId), mgr.sessionId);
check("starts in preflight", mgr.getState() === "preflight");

await mgr.start();

if (prevScenario === undefined) delete process.env.STUB_SCENARIO;
else process.env.STUB_SCENARIO = prevScenario;
fs.rmSync(cwd, { recursive: true, force: true });

check("state went running → done", states.includes("running") && mgr.getState() === "done", states.join("→"));
check("buffered ≥1 event", mgr.getEvents().length >= 1, `got ${mgr.getEvents().length}`);
check("live event listener fired", liveEvents >= 1, `got ${liveEvents}`);

const kinds = mgr.getEvents().map((e) => e.kind);
check("saw a result event", kinds.includes("result"), kinds.join(","));
check("events are sequentially numbered", mgr.getEvents().every((e, i) => e.seq === i));

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
