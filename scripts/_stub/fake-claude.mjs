#!/usr/bin/env node
// Fake `claude` for deterministic AutonomousManager tests. Emits scripted
// stream-json lines to stdout, then exits — no network, no tokens. Behaviour is
// selected by the STUB_SCENARIO env var so later steps can reuse it:
//
//   ok    (default) — a normal successful turn, exit 0        (Step 2)
//   Step 3 will add: limit — usage-limit message + exit 1
//                    done  — writes a DONE file + exit 0
//
// It ignores the claude-style args it's handed; the manager passes them, the stub
// doesn't care.

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const scenario = process.env.STUB_SCENARIO ?? "ok";

emit({ type: "system", subtype: "init", session_id: "stub-session", cwd: process.cwd() });
emit({ type: "assistant", message: { content: [{ type: "text", text: "Working on Step 1: scaffold" }] } });
emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "PLAN.md" } }] } });
emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git commit -m 'feat: step 1'" } }] } });

// scenario branches for later steps land here (limit / done).

emit({
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.01,
  num_turns: 1,
  permission_denials: [],
  session_id: "stub-session",
});

process.exit(0);
