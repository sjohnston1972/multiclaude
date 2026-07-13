import readline from "node:readline";
import type { Readable } from "node:stream";

/**
 * Robust stream-json framing (decisions Q3). `claude --output-format stream-json`
 * emits one JSON object per line. We use readline for newline framing so a line
 * split across read chunks — or a line larger than any single chunk — reassembles
 * correctly; there is no hand-rolled buffer to overflow.
 *
 * A line that won't JSON.parse becomes a `raw` event rather than being dropped:
 * silently swallowing malformed output is exactly the "paper over a problem"
 * failure the feature exists to prevent, and it also feeds the R3 "Show raw log".
 */

export interface ParsedEvent {
  /** stream-json event type, or "raw" for a line that wouldn't parse. */
  kind: string;
  /** the parsed JSON object, or `{ line }` for a raw line. */
  payload: unknown;
}

/** Classify a single line. Returns null for blank lines (nothing to emit). */
export function classifyLine(line: string): ParsedEvent | null {
  if (!line.trim()) return null;
  try {
    const ev = JSON.parse(line) as { type?: unknown };
    return { kind: typeof ev.type === "string" ? ev.type : "unknown", payload: ev };
  } catch {
    return { kind: "raw", payload: { line } };
  }
}

/**
 * Frame a readable stream-json source into events, invoking `onEvent` per line.
 * Resolves when the stream closes.
 */
export function parseStream(input: Readable, onEvent: (ev: ParsedEvent) => void): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const ev = classifyLine(line);
      if (ev) onEvent(ev);
    });
    rl.on("close", () => resolve());
  });
}
