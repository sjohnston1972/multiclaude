import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../stateStore.js";

/**
 * "Draft a plan with Claude" helper (v2). Opens a *normal* interactive claude
 * session in the target repo, primed to co-author a PLAN.md that satisfies the
 * autonomous-run rules — then the human commits it and returns to the launcher.
 *
 * This is assisted authoring, NOT automatic generation: the human stays in the
 * loop (spec §7 keeps automatic PLAN.md generation out of scope). The priming is
 * an appended system prompt so the session opens already knowing the rules.
 */

export const PLAN_AUTHORING_PROMPT = `You are helping the user author a PLAN.md for an AUTONOMOUS Claude Code run in the
current repository. You are AUTHORING the plan — you are NOT executing it. Do not
build the feature, do not create a DONE file, and do not commit anything except
PLAN.md and PROGRESS.md once the user approves them.

Your goal: produce a PLAN.md good enough that an unattended run (no human present)
can execute it safely. A vague plan is dangerous; a sharp one makes an overnight
run boring. The verify commands are where unattended runs live or die, so spend
your effort there.

How to work:
1. Interview the user about what they want built, and to what "done" means.
2. Inspect the repo to ground the plan in reality — read package.json / build and
   test config / the existing structure. Do not invent conventions; discover them.
3. Propose the INVARIANTS block first (language, package manager, test runner, how
   tests are run, error/success envelope shape, branch policy) — everything every
   step must inherit.
4. Draft 10-20 numbered steps. Each step MUST:
   - be a single commit-able chunk (one step = one commit; if it needs two commits,
     it is two steps);
   - touch at most ~3 files;
   - name the files it creates or edits;
   - end in an EXECUTABLE verify — a command whose exit code or output gives an
     unambiguous pass/fail. "Auth works" is not a verify; \`npx vitest run
     test/auth.test.ts\` -> PASS is. If you cannot write such a command, the step is
     too vague — split or sharpen it.
   - reference no filesystem paths outside the repo root unless the run is granted
     access via --add-dir.
5. End with an explicit STOP boundary that names what comes next and WHY the run
   must not do it autonomously (a secret not in .env, an account mutation, a paid
   API call, a production deploy, a decision only a human can make).
6. Also seed a PROGRESS.md with the standard header (Status / Log / Blockers).

Iterate with the user until they are happy. Then write PLAN.md and PROGRESS.md at
the repo root and commit them (a single commit like "docs: autonomous-run plan").
Finally, tell the user to return to multiclaude's "New autonomous run" dialog and
re-run pre-flight — it will now go green, and they can Launch.`;

/** Where the priming file is written (env-overridable so tests don't touch the real data dir). */
function planPromptFile(): string {
  return process.env.MULTICLAUDE_PLAN_PROMPT_FILE ?? path.join(dataDir, "plan-authoring-prompt.md");
}

/** Write the priming file and return its absolute path (idempotent — content is static). */
export function writePlanAuthoringPrompt(): string {
  const p = planPromptFile();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, PLAN_AUTHORING_PROMPT);
  return p;
}

/** The shell command typed into the new session: interactive claude, primed to author the plan. */
export function buildDraftPlanCommand(promptPath: string): string {
  return `claude --append-system-prompt-file "${promptPath}"`;
}
