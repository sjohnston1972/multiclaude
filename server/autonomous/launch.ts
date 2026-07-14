import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PROGRESS_HEADER } from "./templates.js";

/**
 * The launch sequence (R7), run once when a run starts, gated on a green
 * pre-flight. In order:
 *   1. (opt) seed PROGRESS.md + commit, so the tree is clean at tag time
 *   2. create the rollback tag: multiclaude-launch-<task>-<unix>
 *   3. idempotently add /.multiclaude/ to .gitignore (+commit)
 *   4. create .multiclaude/<task>/ and write the pinned session UUID
 * Everything here is reversible by `git reset --hard <tag>` + removing the state
 * dir (Rollback, Step 16).
 */

export interface PrepareLaunchInput {
  projectDir: string;
  taskName: string;
  sessionId: string;
  /** Seed PROGRESS.md if it's missing (the user opted in during pre-flight, R6.4). */
  seedProgress?: boolean;
  /** Unix seconds for the tag name (passed in so callers control the clock). */
  now: number;
}

export interface LaunchArtifacts {
  launchTag: string;
  stateDir: string;
  sessionFile: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", windowsHide: true }).toString();
}

export function prepareLaunch(input: PrepareLaunchInput): LaunchArtifacts {
  const { projectDir, taskName, sessionId, seedProgress, now } = input;

  // 1. Seed PROGRESS.md if asked and missing — commit so the tree is clean for the tag.
  const progressPath = path.join(projectDir, "PROGRESS.md");
  if (seedProgress && !fs.existsSync(progressPath)) {
    fs.writeFileSync(progressPath, PROGRESS_HEADER);
    git(projectDir, ["add", "PROGRESS.md"]);
    git(projectDir, ["commit", "-m", "chore: seed PROGRESS.md for autonomous run"]);
  }

  // 2. Rollback tag — captures the pre-launch state (clean tree, guaranteed by pre-flight).
  const launchTag = `multiclaude-launch-${taskName}-${now}`;
  git(projectDir, ["tag", launchTag]);

  // 3. Idempotently gitignore the state dir (+commit so the tree stays clean).
  const giPath = path.join(projectDir, ".gitignore");
  const content = fs.existsSync(giPath) ? fs.readFileSync(giPath, "utf8") : "";
  const already = content.split(/\r?\n/).some((l) => {
    const t = l.trim().replace(/^\//, "").replace(/\/$/, "");
    return t === ".multiclaude";
  });
  if (!already) {
    const sep = content.length && !content.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(giPath, content + sep + "/.multiclaude/\n");
    git(projectDir, ["add", ".gitignore"]);
    git(projectDir, ["commit", "-m", "chore: gitignore .multiclaude/ (autonomous run state)"]);
  }

  // 4. State dir + pinned session UUID (gitignored, so it doesn't dirty the tree).
  const stateDir = path.join(projectDir, ".multiclaude", taskName);
  fs.mkdirSync(stateDir, { recursive: true });
  const sessionFile = path.join(stateDir, "session");
  fs.writeFileSync(sessionFile, sessionId + "\n");

  return { launchTag, stateDir, sessionFile };
}
