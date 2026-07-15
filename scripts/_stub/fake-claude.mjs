#!/usr/bin/env node
// Fake `claude` for deterministic AutonomousManager/loop tests. Emits scripted
// stream-json to stdout, then exits — no network, no tokens. Behaviour is chosen
// by the STUB_SCENARIO env var:
//
//   ok          (default) a normal successful turn, exit 0 (no DONE — loop continues)
//   done        write a DONE file in cwd, exit 0 (loop should stop → done)
//   blocked     append a real Blockers entry to PROGRESS.md + write DONE, exit 0 (→ blocked)
//   limit       emit a usage-limit message with an ISO reset time, exit 1 (→ sleeping)
//   flaky       drop the connection mid-response on the FIRST call only, exit 1; later
//               calls write DONE and exit 0 (→ the retry should rescue the run). Models
//               the real failure seen on 2026-07-15: a transient API error killing a run
//               that was otherwise healthy. Uses a counter file so it survives respawns.
//   delete-plan delete PLAN.md in cwd, exit 0 (next turn's integrity guard should trip)
//
// It ignores the claude-style args it's handed.

import fs from "node:fs";
import path from "node:path";

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const scenario = process.env.STUB_SCENARIO ?? "ok";
const cwd = process.cwd();

emit({ type: "system", subtype: "init", session_id: "stub-session", cwd });
emit({ type: "assistant", message: { content: [{ type: "text", text: "Working on Step 1: scaffold" }] } });
emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "PLAN.md" } }] } });

if (scenario === "limit") {
  const reset = new Date(Date.now() + 90 * 60 * 1000).toISOString();
  emit({
    type: "assistant",
    message: { content: [{ type: "text", text: `You've hit your session limit. Access resets at ${reset}.` }] },
  });
  emit({ type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0.0, session_id: "stub-session" });
  process.exit(1);
}

if (scenario === "hard-fail") {
  // A non-limit failure that never clears — the only thing that should ever
  // cause a model downgrade. Leaves the tree clean.
  emit({ type: "assistant", message: { content: [{ type: "text", text: "API Error: Connection closed mid-response." }] } });
  process.exit(1);
}

if (scenario === "dirty-fail") {
  // Half-writes a file then dies, like a run killed mid-step. The manager should
  // salvage the leftovers into a WIP commit so the tree ends clean.
  fs.writeFileSync(path.join(cwd, "half-written.ts"), "export const partial = ");
  emit({ type: "assistant", message: { content: [{ type: "text", text: "API Error: Connection closed mid-response." }] } });
  process.exit(1);
}

if (scenario === "flaky") {
  const counter = path.join(cwd, ".stub-calls");
  const calls = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
  fs.writeFileSync(counter, String(calls));
  if (calls === 1) {
    emit({
      type: "assistant",
      message: { content: [{ type: "text", text: "API Error: Connection closed mid-response. The response above may be incomplete." }] },
    });
    process.exit(1);
  }
  fs.writeFileSync(path.join(cwd, "DONE"), "");
}

if (scenario === "delete-plan") {
  try {
    fs.rmSync(path.join(cwd, "PLAN.md"), { force: true });
  } catch {}
}

if (scenario === "done" || scenario === "blocked") {
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git commit -m 'feat: step 1'" } }] } });
  if (scenario === "blocked") {
    const p = path.join(cwd, "PROGRESS.md");
    try {
      const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "## Blockers\n";
      fs.writeFileSync(p, cur + "\n- Step 2 needs a secret not in .env — three options: (a)…\n");
    } catch {}
  }
  fs.writeFileSync(path.join(cwd, "DONE"), "");
}

emit({
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.01,
  num_turns: 1,
  permission_denials: [],
  session_id: "stub-session",
  usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 900, output_tokens: 50 },
});

process.exit(0);
