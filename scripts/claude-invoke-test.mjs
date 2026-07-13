// Step 1 spike (fixes B2): prove the pinned `claude` headless invocation lands a
// REAL commit in a throwaway git repo, under a non-interactive permission mode.
//
// [LIVE] Requires an installed, authenticated `claude` CLI and spends a small
// amount of tokens. Not part of the normal test suite — run it by hand:
//
//     node scripts/claude-invoke-test.mjs
//
// It seeds a temp repo with a one-step PLAN.md + PROGRESS.md + the discipline
// block, then runs the pinned invocation. If the tight Bash scope can't commit,
// it escalates a documented fallback ladder and reports which rung worked.
// PASS = a rung produced a commit that tracks hello.txt containing "hi".

import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- fixtures
// The baked-in autonomous run prompt (spec R10) — sent verbatim every turn.
const R10_PROMPT = `Read PLAN.md and PROGRESS.md as your first action. Identify the next incomplete
step from PLAN.md. Do exactly that one step. Commit each change with a clear
message referring to the step number. Append a timestamped entry to PROGRESS.md
when the step is verified done. If every step in PLAN.md is complete, create an
empty file called DONE and stop. If the plan is ambiguous or a step cannot be
completed, write a precise Blockers entry in PROGRESS.md, create DONE, and stop.
Always re-read PLAN.md and PROGRESS.md at the start of every turn — never trust
prior context.`;

// The 7-point canonical discipline block (docs/specs/claude-md-autonomous-discipline.md).
const DISCIPLINE = `## Autonomous run discipline

If you find both PLAN.md and PROGRESS.md in the current directory, treat this
session as an autonomous or resumable run and follow these rules:

1. **State on disk is truth.** Never trust prior context. Always re-read
   PLAN.md and PROGRESS.md as your first action on every turn.
2. **Small resumable chunks.** Do one step from PLAN.md per turn. Commit
   each change with a clear message referring to the step number. Append a
   timestamped entry to PROGRESS.md when the step is done.
3. **DONE marker.** When every step in PLAN.md is complete, create an empty
   file called DONE and stop.
4. **Never delete state files.** PLAN.md, PROGRESS.md, and DONE are the
   handoff protocol between sessions.
5. **Verify before you claim done.** Run the actual test/build/lint before
   marking a step complete in PROGRESS.md.
6. **If the plan is ambiguous or a step cannot be completed, stop.** Write your
   questions to PROGRESS.md under a "Blockers" heading, then create DONE and stop.
7. **Never scaffold half a step.** If you cannot complete and verify a step,
   leave the working tree clean.
`;

const PLAN = `# Spike — PLAN.md (prove the pinned invocation)

Autonomous-run plan. Do one step per turn, commit, append to PROGRESS.md. Stop after Step 1.

**Invariants:** plain-text only; no dependencies; git identity is already configured.

1. **Create hello.txt.** Create a file \`hello.txt\` at the repo root whose contents are exactly \`hi\`.
   **Verify:** \`hello.txt\` exists at the repo root and contains \`hi\`.
   **Commit:** \`feat: step 1 — add hello.txt\`.

## STOP HERE
When Step 1 is done, create the empty \`DONE\` file and stop.
`;

const PROGRESS = `# Spike — PROGRESS.md

Handoff log for the autonomous run. See PLAN.md for the steps.

## Status

No steps completed yet. Next: **Step 1 — Create hello.txt.**

## Log

## Blockers
`;

// ---------------------------------------------------------------- helpers
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};

const git = (cwd, args) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

/** Fresh throwaway repo, seeded and committed, outside the multiclaude tree. */
function seedRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-spike-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.name", "multiclaude-spike"]);
  git(dir, ["config", "user.email", "spike@multiclaude.local"]);
  fs.writeFileSync(path.join(dir, "PLAN.md"), PLAN);
  fs.writeFileSync(path.join(dir, "PROGRESS.md"), PROGRESS);
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), DISCIPLINE);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "seed: PLAN + PROGRESS + discipline"]);
  return dir;
}

// The pinned invocation, minus the permission strategy (that's the rung).
function baseArgs(uuid) {
  return [
    "-p", R10_PROMPT,
    "--session-id", uuid,
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--model", "sonnet",
    "--max-budget-usd", "3.00", // guardrail; a trivial task costs a few cents
  ];
}

// Fallback ladder — try the tightest safe scope first, escalate only on failure.
const RUNGS = [
  {
    name: "A — acceptEdits + scoped Bash(git/npm/npx/node)",
    extra: [
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read Edit Write Glob Grep Bash(git *) Bash(npm *) Bash(npx *) Bash(node *)",
    ],
  },
  {
    name: "B — acceptEdits + blanket Bash",
    extra: ["--permission-mode", "acceptEdits", "--allowedTools", "Read Edit Write Glob Grep Bash"],
  },
  {
    name: "C — dangerously-skip-permissions (last resort)",
    extra: ["--dangerously-skip-permissions"],
  },
];

/** Run one invocation, streaming a compact live view. Resolves with the result event + exit code. */
function runClaude(dir, uuid, extra) {
  return new Promise((resolve) => {
    const args = [...baseArgs(uuid), ...extra];
    const child = spawn("claude", args, { cwd: dir, windowsHide: true });

    let result = null;
    let stderr = "";
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    rl.on("line", (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return; // partial/non-JSON — ignore for the live view
      }
      if (ev.type === "system" && ev.subtype === "init") {
        console.log("      · session started");
      } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
        for (const c of ev.message.content) {
          if (c.type === "tool_use") {
            const brief =
              c.name === "Bash" ? c.input?.command : c.input?.file_path ?? c.input?.path ?? "";
            console.log(`      🔧 ${c.name}${brief ? "  " + String(brief).slice(0, 80) : ""}`);
          }
        }
      } else if (ev.type === "result") {
        result = ev;
      }
    });

    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, 300_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, result, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, result, stderr: String(err) });
    });
  });
}

/** hello.txt is tracked by git (i.e. it was committed) and contains "hi". */
function commitLanded(dir) {
  const tracked = git(dir, ["ls-files"])
    .split("\n")
    .map((s) => s.trim());
  if (!tracked.includes("hello.txt")) return false;
  const p = path.join(dir, "hello.txt");
  return fs.existsSync(p) && fs.readFileSync(p, "utf8").trim() === "hi";
}

// ---------------------------------------------------------------- run
console.log("Step 1 spike — pinned claude invocation must land a commit (B2)\n");

let winningRung = null;
let lastDir = null;

for (const rung of RUNGS) {
  const dir = seedRepo();
  lastDir = dir;
  const uuid = randomUUID();
  const before = git(dir, ["rev-list", "--count", "HEAD"]);
  console.log(`Rung ${rung.name}`);
  console.log(`  repo: ${dir}`);
  console.log(`  session: ${uuid}`);

  const { code, result, stderr } = await runClaude(dir, uuid, rung.extra);

  const after = git(dir, ["rev-list", "--count", "HEAD"]);
  const newCommits = Number(after) - Number(before);
  const denials = result?.permission_denials ?? [];
  console.log(
    `  exit=${code}  new commits=${newCommits}  cost=$${(result?.total_cost_usd ?? 0).toFixed(4)}` +
      `  is_error=${result?.is_error ?? "?"}  denials=${denials.length}`
  );
  if (denials.length) {
    for (const d of denials.slice(0, 5)) console.log(`    ⛔ denied: ${d.tool_name} ${JSON.stringify(d.tool_input).slice(0, 80)}`);
  }
  if (stderr.trim()) console.log(`    stderr: ${stderr.trim().slice(0, 300)}`);
  if (newCommits > 0) {
    console.log(`  commits:\n${git(dir, ["log", "--oneline"]).split("\n").map((l) => "    " + l).join("\n")}`);
  }

  if (commitLanded(dir)) {
    winningRung = rung.name;
    console.log(`  ✅ commit landed on this rung\n`);
    fs.rmSync(dir, { recursive: true, force: true }); // clean up the winner
    break;
  }
  console.log(`  ✗ no commit on this rung — escalating\n`);
}

check(
  "a rung landed a commit that tracks hello.txt == 'hi'",
  winningRung !== null,
  `all rungs failed; inspect the last repo at ${lastDir}`
);
if (winningRung) {
  check("winning rung is the tightest that works", true);
  console.log(`\nWINNING RUNG: ${winningRung}`);
  console.log("→ Use this permission strategy for the AutonomousManager invocation (Step 2).");
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
