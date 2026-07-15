// Verifies the supervisor loop (Step 3): usage-limit sleep, DONE detection, and
// the state-file integrity guard. Deterministic via the fake-claude stub.
// Run with:  npx tsx scripts/loop-test.ts

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AutonomousManager } from "../server/autonomous/manager.js";
import { parseResetTime, isUsageLimit, hasBlockers, nextModel, tail } from "../server/autonomous/loop.js";

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
async function run(cwd: string, scenario: string, model?: string): Promise<AutonomousManager> {
  const prev = process.env.STUB_SCENARIO;
  process.env.STUB_SCENARIO = scenario;
  const mgr = new AutonomousManager({
    cwd,
    model,
    turnDelayMs: 5,
    retryBackoffMs: [1, 1, 1], // real backoff is 5s/20s/60s — too slow for a test
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

// --- (g) a dying run leaves the tree clean for the next launch ---------------
// The gate it must not trip is pre-flight's clean-tree check; leaving a dirty
// tree is what forced a manual commit/stash after every mid-step death.
{
  const dir = seedRepo();
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");

  const mgr = await run(dir, "dirty-fail", "sonnet"); // sonnet = no downgrade; retries then errors
  const porcelain = execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });
  const subject = execFileSync("git", ["-C", dir, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
  const body = execFileSync("git", ["-C", dir, "log", "-1", "--format=%b"], { encoding: "utf8" });
  const wip = mgr.getEvents().filter((e) => e.kind === "wip-commit");

  check("(g) run ended in error", mgr.getState() === "error", mgr.getState());
  check("(g) working tree is clean again — next launch won't be blocked", porcelain.trim() === "", JSON.stringify(porcelain));
  check("(g) partial work was committed, not discarded", subject.startsWith("wip:"), subject);
  check("(g) the half-written file survived in the commit", execFileSync("git", ["-C", dir, "show", "--stat", "HEAD"], { encoding: "utf8" }).includes("half-written.ts"));
  check("(g) commit says why the run aborted", subject.includes("aborted"), subject);
  check("(g) commit body warns the work is unverified", body.includes("NOT verified"), body.trim());
  check("(g) a wip-commit event was emitted", wip.length === 1 && (wip[0]?.payload as any)?.ok === true, JSON.stringify(wip[0]?.payload));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- (e0) a transient API error is retried, not fatal ------------------------
// Reproduces the real 2026-07-15 failure: "Connection closed mid-response" killed
// a healthy run outright. The same turn retried on the same model must rescue it.
{
  const dir = seedRepo();
  const mgr = await run(dir, "flaky", "fable");
  const retries = mgr.getEvents().filter((e) => e.kind === "turn-retry");
  check("(e0) transient error → run survives to done", mgr.getState() === "done", mgr.getState());
  check("(e0) exactly one retry was needed", retries.length === 1, `retries=${retries.length}`);
  check("(e0) retried on the same model — no downgrade", mgr.activeModel === "fable" && mgr.fellBackFrom === null, mgr.activeModel);
  check("(e0) retry event records the real message", String((retries[0]?.payload as any)?.detail).includes("Connection closed"), JSON.stringify(retries[0]?.payload));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- (e) fable exhausts the chain rather than idling or dying silently -------
{
  const dir = seedRepo();
  const mgr = await run(dir, "limit", "fable"); // stub reports a limit on every turn
  const hops = mgr.getEvents().filter((e) => e.kind === "model-fallback");
  const retries = mgr.getEvents().filter((e) => e.kind === "turn-retry");
  check("(e) each model got its full retry allowance first", retries.length === 9, `retries=${retries.length}`);
  check("(e) fable → opus → sonnet: two fallbacks", hops.length === 2, `hops=${hops.length}`);
  check("(e) first hop is fable → opus", (hops[0]?.payload as any)?.to === "opus", JSON.stringify(hops[0]?.payload));
  check("(e) second hop is opus → sonnet", (hops[1]?.payload as any)?.to === "sonnet", JSON.stringify(hops[1]?.payload));
  check("(e) fallback records why it happened", (hops[0]?.payload as any)?.reason === "usage limit", JSON.stringify(hops[0]?.payload));
  check("(e) activeModel ended at the bottom of the chain", mgr.activeModel === "sonnet", mgr.activeModel);
  check("(e) fellBackFrom remembers the requested model", mgr.fellBackFrom === "fable", String(mgr.fellBackFrom));
  // Only once sonnet — the last link — is limited does the old sleep behaviour apply.
  check("(e) sleeps only after the chain is exhausted", mgr.getState() === "sleeping", mgr.getState());
  mgr.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- (f) a pinned model id is never silently substituted ---------------------
{
  const dir = seedRepo();
  const mgr = await run(dir, "limit", "claude-fable-5"); // not a chain alias
  check("(f) pinned model id does not fall back", mgr.getEvents().every((e) => e.kind !== "model-fallback"));
  check("(f) pinned model id still sleeps on a limit", mgr.getState() === "sleeping", mgr.getState());
  check("(f) activeModel unchanged", mgr.activeModel === "claude-fable-5", mgr.activeModel);
  mgr.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

check("nextModel walks the chain down", nextModel("fable") === "opus" && nextModel("opus") === "sonnet");
check("nextModel stops at the last link", nextModel("sonnet") === null);
check("nextModel ignores unknown models", nextModel("claude-fable-5") === null);
check("tail keeps the end of a long message", tail("x".repeat(500)).endsWith("x") && tail("abc") === "abc");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
