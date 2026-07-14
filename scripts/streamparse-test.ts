// Verifies stream-json line framing (Step 4): events split across chunk
// boundaries reassemble, and a non-JSON line surfaces as a `raw` event.
// Run with:  npx tsx scripts/streamparse-test.ts

import { Readable } from "node:stream";
import { classifyLine, parseStream, type ParsedEvent } from "../server/autonomous/streamParse.js";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};

// --- pure classifier --------------------------------------------------------
check("classifyLine reads a typed event", classifyLine('{"type":"result"}')?.kind === "result");
check("classifyLine skips blank lines", classifyLine("   ") === null);
check("classifyLine flags non-JSON as raw", classifyLine("not json {oops")?.kind === "raw");
check("classifyLine tags typeless JSON as unknown", classifyLine('{"foo":1}')?.kind === "unknown");

// --- streaming with adversarial chunk boundaries ----------------------------
const lines = [
  '{"type":"system","subtype":"init"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
  "this line is not json at all",
  '{"type":"result","total_cost_usd":0.02}',
];
const full = lines.join("\n") + "\n";

// Slice the full payload into fixed 7-byte chunks so JSON objects and the
// newline separators are split mid-line — the exact hazard readline must absorb.
const chunks: Buffer[] = [];
const buf = Buffer.from(full, "utf8");
for (let i = 0; i < buf.length; i += 7) chunks.push(buf.subarray(i, i + 7));

const source = new Readable({
  read() {
    const c = chunks.shift();
    this.push(c ?? null);
  },
});

const got: ParsedEvent[] = [];
await parseStream(source, (ev) => got.push(ev));

check("all four lines produced an event", got.length === 4, `got ${got.length}`);
check("kinds in order", got.map((e) => e.kind).join(",") === "system,assistant,raw,result", got.map((e) => e.kind).join(","));
check("exactly one raw event", got.filter((e) => e.kind === "raw").length === 1);
const raw = got.find((e) => e.kind === "raw");
check("raw carries the offending line", (raw?.payload as { line?: string })?.line === "this line is not json at all");
const result = got.find((e) => e.kind === "result");
check("result payload survived chunk splitting intact", (result?.payload as { total_cost_usd?: number })?.total_cost_usd === 0.02);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
