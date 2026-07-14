// Verifies the event → human line renderer (Step 5): each of the six R3 icon
// kinds maps correctly, and the turn divider is well-formed.
// Run with:  npx tsx scripts/renderevent-test.ts

import { renderEvent, renderTurnDivider, formatDuration } from "../server/autonomous/renderEvent.js";
import { classifyLine } from "../server/autonomous/streamParse.js";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};

const render = (json: string) => renderEvent(classifyLine(json)!);
const one = (json: string) => render(json)[0];

// 📖 read
const read = one('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/repo/PLAN.md"}}]}}');
check("📖 Read → Reading PLAN.md", read?.icon === "📖" && read.summary === "Reading PLAN.md", JSON.stringify(read));

// 💭 step
const step = one('{"type":"assistant","message":{"content":[{"type":"text","text":"Working on Step 1: scaffold\\nmore detail"}]}}');
check("💭 text → step line (first line only)", step?.icon === "💭" && step.summary === "Working on Step 1: scaffold", JSON.stringify(step));

// 🔧 edit
const edit = one('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/package.json"}}]}}');
check("🔧 Edit → Editing package.json", edit?.icon === "🔧" && edit.summary === "Editing package.json", JSON.stringify(edit));

// 🖥️ bash
const bash = one('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm install"}}]}}');
check("🖥️ Bash → Running: npm install", bash?.icon === "🖥️" && bash.summary === "Running: npm install", JSON.stringify(bash));

// 📝 commit
const commit = one('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git commit -m \\"feat: step 1 — add hello\\""}}]}}');
check("📝 git commit → Committing: <msg>", commit?.icon === "📝" && commit.summary === "Committing: feat: step 1 — add hello", JSON.stringify(commit));

// ✅ ok (tool_result success carrying a sha)
const ok = one('{"type":"user","message":{"content":[{"type":"tool_result","is_error":false,"content":"[main abc1234] feat: step 1"}]}}');
check("✅ tool_result → Committed <sha>", ok?.icon === "✅" && ok.summary === "Committed abc1234", JSON.stringify(ok));

// multiple content parts in one assistant message → multiple lines
const multi = render('{"type":"assistant","message":{"content":[{"type":"text","text":"thinking"},{"type":"tool_use","name":"Read","input":{"file_path":"a.ts"}}]}}');
check("assistant with text+tool_use → 2 lines", multi.length === 2 && multi[0].icon === "💭" && multi[1].icon === "📖");

// non-visible events render to nothing
check("system/init renders nothing", render('{"type":"system","subtype":"init"}').length === 0);

// turn divider
check("formatDuration under a minute", formatDuration(12_000) === "12s");
check("formatDuration over a minute", formatDuration(252_000) === "4m 12s");
const divider = renderTurnDivider({ turn: 3, elapsedMs: 252_000, costUsd: 0.42, resumingInSec: 10 });
check("turn divider format", divider === "─── Turn 3 complete · 4m 12s · $0.42 · resuming in 10s ───", divider);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
