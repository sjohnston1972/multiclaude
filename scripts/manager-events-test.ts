// Verifies the manager derives the R2 status strip (Step 6): current step, last
// commit (git-reconciled at the turn boundary), and accumulated cost — from the
// event stream. Deterministic via the fake-claude stub. Run with:
//
//     npx tsx scripts/manager-events-test.ts

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AutonomousManager } from "../server/autonomous/manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stub = path.join(__dirname, "_stub", "fake-claude.mjs");

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

// A real git repo with one seed commit, so last-commit reconciliation has something to read.
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mc-evt-"));
git(cwd, ["init", "-b", "main"]);
git(cwd, ["config", "user.name", "t"]);
git(cwd, ["config", "user.email", "t@t.local"]);
fs.writeFileSync(path.join(cwd, "PLAN.md"), "1. scaffold\n");
fs.writeFileSync(path.join(cwd, "PROGRESS.md"), "## Blockers\n");
git(cwd, ["add", "-A"]);
git(cwd, ["commit", "-m", "seed: fixtures for status strip"]);

const prev = process.env.STUB_SCENARIO;
process.env.STUB_SCENARIO = "done"; // emits step text + git commit + result cost, writes DONE

const mgr = new AutonomousManager({
  cwd,
  turnDelayMs: 5,
  spawn: { command: process.execPath, args: [stub] },
});
await mgr.start();

if (prev === undefined) delete process.env.STUB_SCENARIO;
else process.env.STUB_SCENARIO = prev;

const status = mgr.getStatus();
console.log("  status:", JSON.stringify({ ...status, totalElapsedMs: "…", turnElapsedMs: "…" }));

check("reached done", status.state === "done", status.state);
check("currentStep parsed from 'Working on Step 1: scaffold'", status.currentStep === "Step 1: scaffold", String(status.currentStep));
check("costUsd summed from result event", Math.abs(status.costUsd - 0.01) < 1e-9, String(status.costUsd));
check("lastCommit reconciled from git", status.lastCommit?.subject === "seed: fixtures for status strip", JSON.stringify(status.lastCommit));
check("lastCommit sha looks like a short sha", /^[0-9a-f]{7,}$/.test(status.lastCommit?.sha ?? ""), status.lastCommit?.sha);
check("events carry rendered lines", mgr.getEvents().some((e) => e.rendered.length > 0));

fs.rmSync(cwd, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
