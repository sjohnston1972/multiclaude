import fs from "node:fs";
import path from "node:path";

/**
 * Detects which repos are "autonomous-capable" by the presence of the state files
 * (PLAN.md / PROGRESS.md / DONE). A repo is tagged when it has a PLAN.md; the
 * other two files refine its status. Used to badge repos in the home screen,
 * folder browser, and the launch dialog's quick-pick.
 */

export type AutoRepoStatus = "completed" | "ready" | "drafting" | "none";

export interface AutoRepoInfo {
  path: string;
  name: string;
  hasPlan: boolean;
  hasProgress: boolean;
  hasDone: boolean;
  status: AutoRepoStatus;
}

function has(dir: string, file: string): boolean {
  try {
    return fs.existsSync(path.join(dir, file));
  } catch {
    return false;
  }
}

export function autonomousStatus(dir: string): AutoRepoInfo {
  const hasPlan = has(dir, "PLAN.md");
  const hasProgress = has(dir, "PROGRESS.md");
  const hasDone = has(dir, "DONE");
  // PLAN + DONE = a finished run; PLAN + PROGRESS = ready to launch; PLAN only = mid-draft.
  const status: AutoRepoStatus = !hasPlan ? "none" : hasDone ? "completed" : hasProgress ? "ready" : "drafting";
  return { path: dir, name: path.basename(dir) || dir, hasPlan, hasProgress, hasDone, status };
}

/** Autonomous-capable repos among the candidate dirs (those with a PLAN.md), newest-first order preserved. */
export function listAutonomousRepos(candidateDirs: string[]): AutoRepoInfo[] {
  const seen = new Set<string>();
  const out: AutoRepoInfo[] = [];
  for (const d of candidateDirs) {
    const key = path.resolve(d).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const info = autonomousStatus(d);
    if (info.status !== "none") out.push(info);
  }
  return out;
}
