// Verifies the "Draft a plan with Claude" helper (v2): POST /api/autonomous/draft-plan
// writes the priming file and opens a session running primed interactive claude in
// the target repo. Deterministic — a fake SessionManager captures the spawn instead
// of launching real claude. Run with:  npx tsx scripts/draft-plan-test.ts

import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerAutonomousRoutes } from "../server/autonomous/routes.js";
import { PLAN_AUTHORING_PROMPT, buildDraftPlanCommand } from "../server/autonomous/planAuthoring.js";
import type { SessionManager } from "../server/sessionManager.js";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};

// --- pure builder + prompt content ------------------------------------------
check("command runs primed interactive claude (no permission pestering)", buildDraftPlanCommand("C:\\x\\p.md") === 'claude --append-system-prompt-file "C:\\x\\p.md" --dangerously-skip-permissions');
check("prompt says AUTHOR, not execute", /AUTHORING the plan/.test(PLAN_AUTHORING_PROMPT) && /NOT executing/i.test(PLAN_AUTHORING_PROMPT));
check("prompt insists on an executable verify per step", /EXECUTABLE verify/.test(PLAN_AUTHORING_PROMPT));
check("prompt requires a STOP boundary", /STOP boundary/.test(PLAN_AUTHORING_PROMPT));
check("prompt covers invariants + one-commit-per-step", /INVARIANTS/.test(PLAN_AUTHORING_PROMPT) && /one step = one commit/.test(PLAN_AUTHORING_PROMPT));

// --- route with a fake SessionManager ---------------------------------------
const promptFile = path.join(os.tmpdir(), `mc-planprompt-${process.pid}.md`);
process.env.MULTICLAUDE_PLAN_PROMPT_FILE = promptFile;

let captured: { cwd?: string; initialCommand?: string } | null = null;
const fakeSessions = {
  create(opts: { cwd?: string; initialCommand?: string }) {
    captured = opts;
    return { id: "sess-1" };
  },
  info(s: { id: string }) {
    return { id: s.id, title: "draft-plan", cwd: captured?.cwd };
  },
} as unknown as SessionManager;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-draft-"));
const app = Fastify();
registerAutonomousRoutes(app, fakeSessions);

const res = await app.inject({ method: "POST", url: "/api/autonomous/draft-plan", payload: { projectDir: dir } });
const info = res.json();
check("draft-plan → 200 with a session", res.statusCode === 200 && info.id === "sess-1", String(res.statusCode));
check("session opened in the project dir", captured?.cwd === dir, String(captured?.cwd));
check("session runs primed claude", (captured?.initialCommand ?? "").startsWith("claude --append-system-prompt-file"), captured?.initialCommand);
check("priming file was written with the rules", fs.existsSync(promptFile) && /EXECUTABLE verify/.test(fs.readFileSync(promptFile, "utf8")));
check("initialCommand points at the written priming file", (captured?.initialCommand ?? "").includes(promptFile));

// bad dir → 400
const bad = await app.inject({ method: "POST", url: "/api/autonomous/draft-plan", payload: { projectDir: path.join(dir, "nope") } });
check("missing dir → 400 + error", bad.statusCode === 400 && typeof bad.json().error === "string");

await app.close();
try {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(promptFile, { force: true });
} catch {
  /* best effort */
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
