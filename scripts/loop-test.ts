// Verifies the supervisor loop (Step 3): usage-limit sleep, DONE detection, and
// the state-file integrity guard. Deterministic via the fake-claude stub.
// Run with:  npx tsx scripts/loop-test.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AutonomousManager } from "../server/autonomous/manager.js";
import { parseResetTime, isUsageLimit, hasBlockers } from "../server/autonomous/loop.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stub = path.join(__dirname, "_stub", "fake-claude.mjs");

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};

function seedRepo(withPlan = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-loop-"));
  if (withPlan) fs.writeFileSync(path.join(dir, "PLAN.md"), "1. do a thing\n");
  fs.writeFileSync(path.join(dir, "PROGRESS.md"), "## Blockers\n");
  return dir;
}

/** Run a scenario to completion (or to a non-running resting state) and return the manager. */
async function run(cwd: string, scenario: string): Promise<AutonomousManager> {
  const prev = process.env.STUB_SCENARIO;
  process.env.STUB_SCENARIO = scenario;
  const mgr = new AutonomousManager({
    cwd,
    turnDelayMs: 5,
    spawn: { command: process.execPath, args: [stub] },
  });
  await mgr.start();
  if (prev === undefined) delete process.env.STUB_SCENARIO;
  else process.env.STUB_SCENARIO = prev;
  return mgr;
}

// --- pure helpers -----------------------------------------------------------
check("isUsageLimit matches session-limit text", isUsageLimit("you have hit your session limit"));
check("isUsageLimit ignores unrelated errors", !isUsageLimit("git commit failed"));
const now = Date.UTC(2026, 6, 13, 12, 0, 0);
check(
  "parseResetTime reads an ISO timestamp",
  parseResetTime("resets at 2026-07-13T15:30:00Z now", now) === Date.UTC(2026, 6, 13, 15, 30, 0)
);
check("parseResetTime falls back to +1h when unparseable", parseResetTime("no time here", now) === now + 3600_000);
check("hasBlockers false on empty template section", !hasBlockers("## Blockers\n\n<!-- write here -->\n"));
check("hasBlockers false on '- (none)' placeholder", !hasBlockers("## Blockers\n\n- (none)\n"));
check("hasBlockers false on 'None.' placeholder", !hasBlockers("## Blockers\nNone.\n"));
check("hasBlockers false on 'N/A' placeholder", !hasBlockers("## Blockers\nN/A\n"));
check("hasBlockers false on 'No blockers yet'", !hasBlockers("## Blockers\n\nNo blockers yet\n"));
check("hasBlockers true on populated section", hasBlockers("## Blockers\n- real problem\n"));
check("hasBlockers true on a real 'no'-starting blocker", hasBlockers("## Blockers\n- No API key for the service; three options: (a)…\n"));

// --- (a) usage limit → sleeping ---------------------------------------------
{
  const dir = seedRepo();
  const mgr = await run(dir, "limit");
  check("(a) limit → state sleeping", mgr.getState() === "sleeping", mgr.getState());
  check("(a) wakeAt is a future time", (mgr.wakeAt ?? 0) > Date.now(), String(mgr.wakeAt));
  mgr.stop(); // cancel the pending resume timer
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- (b) DONE → done --------------------------------------------------------
{
  const dir = seedRepo();
  const mgr = await run(dir, "done");
  check("(b) DONE → state done", mgr.getState() === "done", mgr.getState());
  check("(b) DONE file was created", fs.existsSync(path.join(dir, "DONE")));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- (c) state-file vanishes between turns → error, no further invocation ----
{
  const dir = seedRepo();
  const mgr = await run(dir, "delete-plan"); // turn 1 runs and deletes PLAN.md; turn 2's guard trips
  check("(c) missing PLAN.md → state error", mgr.getState() === "error", mgr.getState());
  check("(c) error names PLAN.md", (mgr.lastError ?? "").includes("PLAN.md"), String(mgr.lastError));
  const initEvents = mgr.getEvents().filter((e) => e.kind === "system").length;
  check("(c) exactly one invocation happened (no marching into a void)", initEvents === 1, `init events=${initEvents}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- integrity guard also trips before the very first invocation ------------
{
  const dir = seedRepo(false); // no PLAN.md at all
  const mgr = await run(dir, "ok");
  check("(d) absent PLAN.md from the start → error before any spawn", mgr.getState() === "error", mgr.getState());
  check("(d) no events buffered (stub never spawned)", mgr.getEvents().length === 0, `events=${mgr.getEvents().length}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
