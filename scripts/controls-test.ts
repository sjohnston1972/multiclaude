// Verifies the R5 controls (Step 16): pause → paused, resume → running, and
// rollback → HEAD back at the launch tag with the state dir removed and no
// residual files. In-process via app.inject(), stub-driven.
// Run with:  npx tsx scripts/controls-test.ts

import Fastify from "fastify";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerAutonomousRoutes } from "../server/autonomous/routes.js";
import { __setSpawnOverride, __resetForTests } from "../server/autonomous/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stub = path.join(__dirname, "_stub", "fake-claude.mjs");

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const goodMd = path.join(os.tmpdir(), `mc-ctl-md-${process.pid}.md`);
fs.writeFileSync(goodMd, "## Autonomous run discipline\n1. rules\n");
process.env.MULTICLAUDE_CLAUDE_MD = goodMd;
process.env.MULTICLAUDE_AUTONOMOUS_FILE = path.join(os.tmpdir(), `mc-ctl-records-${process.pid}.json`);
process.env.STUB_SCENARIO = "ok"; // keeps the run "running" (it loops; 10s default turn delay)
__setSpawnOverride({ command: process.execPath, args: [stub] });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-ctl-"));
git(dir, ["init", "-b", "main"]);
git(dir, ["config", "user.name", "t"]);
git(dir, ["config", "user.email", "t@t.local"]);
fs.writeFileSync(path.join(dir, "PLAN.md"), "1. do a thing\n");
fs.writeFileSync(path.join(dir, "PROGRESS.md"), "## Blockers\n");
git(dir, ["add", "-A"]);
git(dir, ["commit", "-m", "seed"]);

const app = Fastify();
registerAutonomousRoutes(app);

const launched = (await app.inject({ method: "POST", url: "/api/autonomous/launch", payload: { taskName: "ctl-task", projectDir: dir } })).json();
const id = launched.id;
const tagSha = git(dir, ["rev-parse", launched.launchTag]);
await sleep(150); // let the first turn set state = running

// --- pause ------------------------------------------------------------------
const paused = (await app.inject({ method: "POST", url: `/api/autonomous/${id}/pause` })).json();
check("pause → state paused", paused.state === "paused", paused.state);

// --- resume -----------------------------------------------------------------
const resumed = (await app.inject({ method: "POST", url: `/api/autonomous/${id}/resume` })).json();
await sleep(100);
const afterResume = (await app.inject({ url: `/api/autonomous/${id}` })).json();
check("resume → running again", resumed.state === "running" || afterResume.state === "running", `${resumed.state}/${afterResume.state}`);

// Pause before rollback so no invocation is mid-flight, then simulate run progress.
await app.inject({ method: "POST", url: `/api/autonomous/${id}/pause` });
fs.writeFileSync(path.join(dir, "run-artifact.txt"), "work from the run");
git(dir, ["add", "-A"]);
git(dir, ["commit", "-m", "run: step 1 (to be rolled back)"]);
check("state dir exists before rollback", fs.existsSync(path.join(dir, ".multiclaude", "ctl-task")));

// --- rollback ---------------------------------------------------------------
const rb = await app.inject({ method: "POST", url: `/api/autonomous/${id}/rollback` });
const rbBody = rb.json();
check("rollback → 200 with the exact command", rb.statusCode === 200 && typeof rbBody.command === "string" && rbBody.command.includes("git reset --hard"));
check("HEAD is back at the launch tag", git(dir, ["rev-parse", "HEAD"]) === tagSha, `${git(dir, ["rev-parse", "HEAD"])} vs ${tagSha}`);
check("run artifact removed (no residual files)", !fs.existsSync(path.join(dir, "run-artifact.txt")));
check("state dir removed", !fs.existsSync(path.join(dir, ".multiclaude", "ctl-task")));
check("working tree clean after rollback", git(dir, ["status", "--porcelain"]) === "");

__resetForTests();
await app.close();
await sleep(300);
try {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(goodMd, { force: true });
  fs.rmSync(process.env.MULTICLAUDE_AUTONOMOUS_FILE!, { force: true });
} catch {
  /* best effort */
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
