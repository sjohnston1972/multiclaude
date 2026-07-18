// Verifies the supervisor loop (Step 3): usage-limit sleep, DONE detection, and
// the state-file integrity guard. Deterministic via the fake-claude stub.
// Run with:  npx tsx scripts/loop-test.ts

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AutonomousManager, buildClaudeArgs } from "../server/autonomous/manager.js";
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
async function run(
  cwd: string,
  scenario: string,
  model?: string,
  extra?: Partial<import("../server/autonomous/types.js").AutonomousConfig>
): Promise<AutonomousManager> {
  const prev = process.env.STUB_SCENARIO;
  process.env.STUB_SCENARIO = scenario;
  const mgr = new AutonomousManager({
    cwd,
    model,
    turnDelayMs: 5,
    retryBackoffMs: [1, 1, 1], // real backoff is 5s/20s/60s — too slow for a test
    spawn: { command: process.execPath, args: [stub] },
    ...extra,
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
  const begins = mgr.getEvents().filter((e) => e.kind === "turn-begin");
  const ids = begins.map((e) => (e.payload as any).conversationId as string);
  check("(e0) two turns were begun", begins.length === 2, `begins=${begins.length}`);
  check("(e0) the retry got a fresh conversation id", new Set(ids).size === 2, JSON.stringify(ids));
  check("(e0) turn 1 used the pinned run UUID", ids[0] === mgr.sessionId, `${ids[0]} vs ${mgr.sessionId}`);
  check("(e0) no turn resumed", begins.every((e) => (e.payload as any).resumed === false), JSON.stringify(begins.map((e) => (e.payload as any).resumed)));
  check("(e0) the run identity is unchanged by all this", /^[0-9a-f-]{36}$/.test(mgr.sessionId), mgr.sessionId);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- (e) a usage limit NEVER downgrades — it's account-wide ------------------
// Regression test for the real 2026-07-15 fault: a "hit your session limit ·
// resets 5:50pm" burned fable → opus → sonnet in 12 attempts over 5 minutes,
// then slept anyway and left the run on sonnet long after the limit cleared.
// A limit blocks every model, so downgrading cannot help. Sleep on the model
// the operator chose.
{
  const dir = seedRepo();
  const mgr = await run(dir, "limit", "fable");
  const hops = mgr.getEvents().filter((e) => e.kind === "model-fallback");
  const retries = mgr.getEvents().filter((e) => e.kind === "turn-retry");
  const limits = mgr.getEvents().filter((e) => e.kind === "usage-limit");
  check("(e) usage limit → no downgrade at all", hops.length === 0, `hops=${hops.length}`);
  check("(e) usage limit → no pointless retries either", retries.length === 0, `retries=${retries.length}`);
  check("(e) stays on the model the operator chose", mgr.activeModel === "fable", mgr.activeModel);
  check("(e) nothing to report as a fallback", mgr.fellBackFrom === null, String(mgr.fellBackFrom));
  check("(e) sleeps until the limit resets", mgr.getState() === "sleeping", mgr.getState());
  check("(e) wakeAt is in the future", (mgr.wakeAt ?? 0) > Date.now(), String(mgr.wakeAt));
  check("(e) emits a usage-limit event with the message", limits.length === 1 && String((limits[0]?.payload as any)?.detail).includes("limit"), JSON.stringify(limits[0]?.payload));
  mgr.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- (e1) a non-limit failure IS what walks the chain ------------------------
{
  const dir = seedRepo();
  const mgr = await run(dir, "hard-fail", "fable"); // never clears, and isn't a limit
  const hops = mgr.getEvents().filter((e) => e.kind === "model-fallback");
  const retries = mgr.getEvents().filter((e) => e.kind === "turn-retry");
  check("(e1) each model got its full retry allowance first", retries.length === 9, `retries=${retries.length}`);
  check("(e1) fable → opus → sonnet: two fallbacks", hops.length === 2, `hops=${hops.length}`);
  check("(e1) first hop is fable → opus", (hops[0]?.payload as any)?.to === "opus", JSON.stringify(hops[0]?.payload));
  check("(e1) second hop is opus → sonnet", (hops[1]?.payload as any)?.to === "sonnet", JSON.stringify(hops[1]?.payload));
  check("(e1) activeModel ended at the bottom of the chain", mgr.activeModel === "sonnet", mgr.activeModel);
  check("(e1) fellBackFrom remembers the requested model", mgr.fellBackFrom === "fable", String(mgr.fellBackFrom));
  check("(e1) chain exhausted on a non-limit failure → error, not sleep", mgr.getState() === "error", mgr.getState());
  check("(e1) error carries the real output", (mgr.lastError ?? "").includes("Connection closed"), String(mgr.lastError));
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

// --- (h) freshSessionPerTurn:false restores the old resuming behaviour --------
{
  const dir = seedRepo();
  const mgr = await run(dir, "flaky", "fable", { freshSessionPerTurn: false });
  const begins = mgr.getEvents().filter((e) => e.kind === "turn-begin");
  const ids = begins.map((e) => (e.payload as any).conversationId as string);
  check("(h) legacy: two turns were begun", begins.length === 2, `begins=${begins.length}`);
  check("(h) legacy: both turns share the run UUID", new Set(ids).size === 1 && ids[0] === mgr.sessionId, JSON.stringify(ids));
  check("(h) legacy: turn 1 does not resume", (begins[0]?.payload as any)?.resumed === false, JSON.stringify(begins[0]?.payload));
  check("(h) legacy: turn 2 resumes", (begins[1]?.payload as any)?.resumed === true, JSON.stringify(begins[1]?.payload));
  fs.rmSync(dir, { recursive: true, force: true });
}

check("nextModel walks the chain down", nextModel("fable") === "opus" && nextModel("opus") === "sonnet");
check("nextModel stops at the last link", nextModel("sonnet") === null);
check("nextModel ignores unknown models", nextModel("claude-fable-5") === null);
check("tail keeps the end of a long message", tail("x".repeat(500)).endsWith("x") && tail("abc") === "abc");

// --- buildClaudeArgs: fresh mode pins a conversation id, legacy resumes -------
{
  const cfg = { cwd: "/tmp" };
  const fresh = buildClaudeArgs(cfg, "conv-abc", false, "sonnet");
  const i = fresh.indexOf("--session-id");
  check("buildClaudeArgs passes the conversation id to --session-id", i >= 0 && fresh[i + 1] === "conv-abc", JSON.stringify(fresh));
  check("buildClaudeArgs never resumes in fresh mode", !fresh.includes("--resume"), JSON.stringify(fresh));

  const legacy = buildClaudeArgs(cfg, "conv-abc", true, "sonnet");
  check("legacy mode still emits --resume", legacy.includes("--resume"), JSON.stringify(legacy));
  check("legacy mode omits --session-id", !legacy.includes("--session-id"), JSON.stringify(legacy));
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
