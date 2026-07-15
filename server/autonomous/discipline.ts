import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The "Autonomous run discipline" block (R3.3 / R6.6) — the behavioural contract
 * that makes an unattended run safe. Pre-flight detects whether it's present in
 * the user-global CLAUDE.md; this module is the *action* that appends it when the
 * user offers to (Step: discipline append). Canonical 7-point version, verbatim
 * from docs/specs/claude-md-autonomous-discipline.md.
 *
 * Heading-match only: if the section already exists we never touch it — a shorter
 * hand-edited version is left alone rather than clobbered (decisions Q4).
 */

/** The user-global CLAUDE.md, env-overridable so tests never touch the real machine. */
export function claudeMdPath(): string {
  return process.env.MULTICLAUDE_CLAUDE_MD ?? path.join(os.homedir(), ".claude", "CLAUDE.md");
}

/** Matches the section heading, not the body — so we detect presence, not exact text. */
export const DISCIPLINE_HEADING = /^##\s+Autonomous run discipline/m;

export const DISCIPLINE_BLOCK = `## Autonomous run discipline

If you find both PLAN.md and PROGRESS.md in the current directory, treat this
session as an autonomous or resumable run and follow these rules:

1. **State on disk is truth.** Never trust prior context. Always re-read
   PLAN.md and PROGRESS.md as your first action on every turn.

2. **Small resumable chunks.** Do one step from PLAN.md per turn. Commit
   each change with a clear message referring to the step number, then \`git push\`
   it — a run's work must never exist only on this machine. Append a timestamped
   entry to PROGRESS.md when the step is done. Push to the branch the run is
   already on; don't create branches. If the push fails (no remote, no upstream,
   auth, rejected), that is NOT a blocker: note it in PROGRESS.md and carry on —
   the commits are still safe locally.

3. **DONE marker.** When every step in PLAN.md is complete, create an
   empty file called DONE and stop.

4. **Never delete state files.** PLAN.md, PROGRESS.md, and DONE are the
   handoff protocol between sessions.

5. **Verify before you claim done.** Run the actual test, build, or lint
   command named in the step before marking it complete in PROGRESS.md.

6. **If the plan is ambiguous or a step cannot be completed, stop.** Write
   your questions to PROGRESS.md under a "Blockers" heading — be precise, name
   the exact file, path, or condition that failed, and give me concrete options
   to unblock it. Then create DONE and stop. Do not guess your way into
   unrecoverable changes overnight.

7. **Never scaffold half a step.** If you cannot complete a step and verify it,
   leave the working tree clean. A partially-written config that references a
   missing dependency is worse than nothing.
`;

export interface AppendDisciplineResult {
  path: string;
  appended: boolean;
  alreadyPresent: boolean;
}

/**
 * Ensure the discipline block is present in the user-global CLAUDE.md. Idempotent:
 * if the heading already exists, no write happens. Creates the file (and ~/.claude)
 * if absent.
 */
export function appendDiscipline(): AppendDisciplineResult {
  const p = claudeMdPath();
  let content = "";
  try {
    content = fs.readFileSync(p, "utf8");
  } catch {
    /* file doesn't exist yet — we'll create it */
  }
  if (DISCIPLINE_HEADING.test(content)) {
    return { path: p, appended: false, alreadyPresent: true };
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const sep = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(p, content + sep + DISCIPLINE_BLOCK);
  return { path: p, appended: true, alreadyPresent: false };
}
