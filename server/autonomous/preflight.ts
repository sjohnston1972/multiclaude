import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileA = promisify(execFile);

/**
 * Pre-flight validation (R6). Every check reports ✅/⚠️/❌ so the UI can gate
 * Launch: disabled while any `fail` remains; each `warn` needs an explicit
 * "I accept this risk". This module covers checks 1-4, 6, 7; the PLAN.md path
 * scan (check 5) lives in pathScan.ts and is merged in by the route.
 */

export type CheckLevel = "ok" | "warn" | "fail";
export interface PreflightCheck {
  id: string;
  label: string;
  level: CheckLevel;
  detail: string;
}
export interface PreflightResult {
  checks: PreflightCheck[];
  /** PROGRESS.md missing → offer to seed + commit it (R6.4). */
  seedable: boolean;
  /** Discipline block missing from CLAUDE.md → offer to append (R6.6). */
  disciplineOfferAppend: boolean;
  /** No ❌ remaining — Launch may be enabled (⚠️ still require explicit accept in the UI). */
  canLaunch: boolean;
}

/** The user-global CLAUDE.md, env-overridable so tests don't depend on the real machine. */
export function claudeMdPath(): string {
  return process.env.MULTICLAUDE_CLAUDE_MD ?? path.join(os.homedir(), ".claude", "CLAUDE.md");
}

const DISCIPLINE_HEADING = /^##\s+Autonomous run discipline/m;

export async function runPreflight(projectDir: string): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  let seedable = false;
  let disciplineOfferAppend = false;

  // 1. project directory is a git repo
  let isRepo = false;
  try {
    const { stdout } = await execFileA("git", ["-C", projectDir, "rev-parse", "--is-inside-work-tree"], { timeout: 5000, windowsHide: true });
    isRepo = stdout.trim() === "true";
  } catch {
    /* not a repo / git missing */
  }
  checks.push({
    id: "git-repo",
    label: "Project directory is a git repo",
    level: isRepo ? "ok" : "fail",
    detail: isRepo ? projectDir : `Not a git repository: ${projectDir}`,
  });

  // 2. working tree clean
  if (isRepo) {
    try {
      const { stdout } = await execFileA("git", ["-C", projectDir, "status", "--porcelain"], { timeout: 5000, windowsHide: true });
      const clean = stdout.trim() === "";
      checks.push({
        id: "clean-tree",
        label: "Working tree is clean",
        level: clean ? "ok" : "fail",
        detail: clean ? "no uncommitted changes" : "uncommitted changes present — commit or stash before launching",
      });
    } catch {
      checks.push({ id: "clean-tree", label: "Working tree is clean", level: "fail", detail: "couldn't read git status" });
    }
  } else {
    checks.push({ id: "clean-tree", label: "Working tree is clean", level: "fail", detail: "not a git repo" });
  }

  // 3. PLAN.md exists
  const planExists = fs.existsSync(path.join(projectDir, "PLAN.md"));
  checks.push({
    id: "plan",
    label: "PLAN.md exists at repo root",
    level: planExists ? "ok" : "fail",
    detail: planExists ? "found" : "No PLAN.md — writing it is your job, and the highest-leverage part (R11)",
  });

  // 4. PROGRESS.md exists (else offer to seed)
  const progressExists = fs.existsSync(path.join(projectDir, "PROGRESS.md"));
  if (progressExists) {
    checks.push({ id: "progress", label: "PROGRESS.md exists at repo root", level: "ok", detail: "found" });
  } else {
    seedable = true;
    checks.push({ id: "progress", label: "PROGRESS.md exists at repo root", level: "warn", detail: "missing — multiclaude can seed it and commit before launch" });
  }

  // 6. discipline block present (heading-match only — never overwrite a shorter live version)
  try {
    const md = fs.readFileSync(claudeMdPath(), "utf8");
    if (DISCIPLINE_HEADING.test(md)) {
      checks.push({ id: "discipline", label: "Autonomous run discipline installed", level: "ok", detail: "found in CLAUDE.md" });
    } else {
      disciplineOfferAppend = true;
      checks.push({ id: "discipline", label: "Autonomous run discipline installed", level: "warn", detail: "missing from CLAUDE.md — multiclaude can append it" });
    }
  } catch {
    disciplineOfferAppend = true;
    checks.push({ id: "discipline", label: "Autonomous run discipline installed", level: "warn", detail: "no CLAUDE.md yet — multiclaude can create it" });
  }

  // 7. claude CLI on PATH
  try {
    const { stdout } = await execFileA("claude", ["--version"], { timeout: 10000, windowsHide: true });
    checks.push({ id: "claude-cli", label: "claude CLI available", level: "ok", detail: stdout.trim() });
  } catch {
    checks.push({ id: "claude-cli", label: "claude CLI available", level: "fail", detail: "`claude` isn't on PATH" });
  }

  return { checks, seedable, disciplineOfferAppend, canLaunch: checks.every((c) => c.level !== "fail") };
}
