// Verifies the launch sequence (Step 15, R7): rollback tag created, state dir +
// session UUID written, /.multiclaude/ gitignored exactly once, and the working
// tree left clean. Also that a failing pre-flight blocks launch. In-process.
// Run with:  npx tsx scripts/launch-test.ts

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

function seedRepo(withProgress = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-launch-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "user.email", "t@t.local"]);
  fs.writeFileSync(path.join(dir, "PLAN.md"), "1. do a thing\n");
  if (withProgress) fs.writeFileSync(path.join(dir, "PROGRESS.md"), "## Blockers\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "seed"]);
  return dir;
}

// discipline present so pre-flight is green
const goodMd = path.join(os.tmpdir(), `mc-launch-md-${process.pid}.md`);
fs.writeFileSync(goodMd, "## Autonomous run discipline\n\n1. rules\n");
process.env.MULTICLAUDE_CLAUDE_MD = goodMd;
// "ok" stub writes no files, so the post-launch clean-tree check reflects
// prepareLaunch's result rather than racing the run's first DONE write.
process.env.STUB_SCENARIO = "ok";
process.env.MULTICLAUDE_AUTONOMOUS_FILE = path.join(os.tmpdir(), `mc-launch-records-${process.pid}.json`);
process.env.MULTICLAUDE_ADDDIRS_FILE = path.join(os.tmpdir(), `mc-launch-adddirs-${process.pid}.json`);
__setSpawnOverride({ command: process.execPath, args: [stub] });

const app = Fastify();
registerAutonomousRoutes(app);

// --- happy path -------------------------------------------------------------
const dir = seedRepo();
const res = await app.inject({ method: "POST", url: "/api/autonomous/launch", payload: { taskName: "my-task", projectDir: dir } });
const rec = res.json();
check("launch → 200", res.statusCode === 200, `${res.statusCode} ${JSON.stringify(rec).slice(0, 120)}`);
check("record carries a launchTag", typeof rec.launchTag === "string" && rec.launchTag.startsWith("multiclaude-launch-my-task-"), rec.launchTag);

const tags = git(dir, ["tag", "-l"]).split(/\r?\n/).filter(Boolean);
check("rollback tag exists in the repo", tags.some((t) => t === rec.launchTag), tags.join(","));

const sessionFile = path.join(dir, ".multiclaude", "my-task", "session");
check(".multiclaude/<task>/session exists", fs.existsSync(sessionFile));
check("session file holds the pinned UUID", fs.existsSync(sessionFile) && fs.readFileSync(sessionFile, "utf8").trim() === rec.sessionId);

const gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
const ignoreLines = gitignore.split(/\r?\n/).filter((l) => l.trim().replace(/^\//, "").replace(/\/$/, "") === ".multiclaude");
check("/.multiclaude/ in .gitignore exactly once", ignoreLines.length === 1, `count=${ignoreLines.length}`);

check("working tree is clean after launch", git(dir, ["status", "--porcelain"]) === "", git(dir, ["status", "--porcelain"]));

// --- pre-flight blocks a dirty tree -----------------------------------------
const dirty = seedRepo();
fs.writeFileSync(path.join(dirty, "uncommitted.txt"), "x");
const blocked = await app.inject({ method: "POST", url: "/api/autonomous/launch", payload: { taskName: "dirty-task", projectDir: dirty } });
check("dirty tree → launch blocked with 400", blocked.statusCode === 400 && typeof blocked.json().error === "string");
check("no rollback tag created when blocked", git(dirty, ["tag", "-l"]).trim() === "");

__resetForTests();
await app.close();
await new Promise((r) => setTimeout(r, 300));
for (const d of [dir, dirty]) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
try {
  fs.rmSync(goodMd, { force: true });
  fs.rmSync(process.env.MULTICLAUDE_AUTONOMOUS_FILE!, { force: true });
} catch {
  /* best effort */
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
