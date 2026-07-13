// Verifies core pre-flight checks (Step 13, R6.1-4,6,7): a clean repo with
// PLAN+PROGRESS + discipline is all-ok; a dirty tree fails; a missing discipline
// heading warns + offers append; a missing PROGRESS.md warns + seedable.
// Run with:  npx tsx scripts/preflight-test.ts

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPreflight } from "../server/autonomous/preflight.js";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
const level = (r: { checks: { id: string; level: string }[] }, id: string) => r.checks.find((c) => c.id === id)?.level;

function seedRepo(withProgress = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-pf-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "user.email", "t@t.local"]);
  fs.writeFileSync(path.join(dir, "PLAN.md"), "1. do a thing\n");
  if (withProgress) fs.writeFileSync(path.join(dir, "PROGRESS.md"), "## Blockers\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "seed"]);
  return dir;
}

// A CLAUDE.md WITH the discipline heading, and one WITHOUT.
const goodMd = path.join(os.tmpdir(), `mc-pf-good-${process.pid}.md`);
const badMd = path.join(os.tmpdir(), `mc-pf-bad-${process.pid}.md`);
fs.writeFileSync(goodMd, "# stuff\n\n## Autonomous run discipline\n\n1. rules\n");
fs.writeFileSync(badMd, "# stuff\n\nno discipline here\n");

// --- clean, fully configured repo → all ok ----------------------------------
{
  process.env.MULTICLAUDE_CLAUDE_MD = goodMd;
  const dir = seedRepo();
  const r = await runPreflight(dir);
  check("clean repo: git-repo ok", level(r, "git-repo") === "ok");
  check("clean repo: clean-tree ok", level(r, "clean-tree") === "ok");
  check("clean repo: plan ok", level(r, "plan") === "ok");
  check("clean repo: progress ok", level(r, "progress") === "ok");
  check("clean repo: discipline ok", level(r, "discipline") === "ok", JSON.stringify(r.checks.find((c) => c.id === "discipline")));
  check("clean repo: claude-cli ok", level(r, "claude-cli") === "ok");
  check("clean repo: canLaunch true", r.canLaunch === true);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- dirty tree → clean-tree fail, cannot launch ----------------------------
{
  process.env.MULTICLAUDE_CLAUDE_MD = goodMd;
  const dir = seedRepo();
  fs.writeFileSync(path.join(dir, "uncommitted.txt"), "dirty");
  const r = await runPreflight(dir);
  check("dirty tree: clean-tree fail", level(r, "clean-tree") === "fail");
  check("dirty tree: canLaunch false", r.canLaunch === false);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- missing discipline heading → warn + offer append -----------------------
{
  process.env.MULTICLAUDE_CLAUDE_MD = badMd;
  const dir = seedRepo();
  const r = await runPreflight(dir);
  check("no discipline: discipline warn", level(r, "discipline") === "warn");
  check("no discipline: disciplineOfferAppend true", r.disciplineOfferAppend === true);
  check("no discipline: still canLaunch (warn only)", r.canLaunch === true);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- missing PROGRESS.md → warn + seedable ----------------------------------
{
  process.env.MULTICLAUDE_CLAUDE_MD = goodMd;
  const dir = seedRepo(false);
  const r = await runPreflight(dir);
  check("no PROGRESS.md: progress warn", level(r, "progress") === "warn");
  check("no PROGRESS.md: seedable true", r.seedable === true);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- non-repo dir → git-repo fail -------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-pf-norepo-"));
  const r = await runPreflight(dir);
  check("non-repo: git-repo fail", level(r, "git-repo") === "fail");
  check("non-repo: canLaunch false", r.canLaunch === false);
  fs.rmSync(dir, { recursive: true, force: true });
}

try {
  fs.rmSync(goodMd, { force: true });
  fs.rmSync(badMd, { force: true });
} catch {
  /* best effort */
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
