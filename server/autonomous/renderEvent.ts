import path from "node:path";
import type { ParsedEvent } from "./streamParse.js";

/**
 * Turn parsed stream-json events into the human-readable log lines of R3 — one
 * icon + short summary per action. A single assistant message can bundle several
 * content parts (text + tool_use), so this returns an array; non-visible events
 * (system init, partial stream chunks) render to nothing.
 */

export interface RenderedLine {
  icon: string;
  summary: string;
}

const base = (p: unknown): string => (typeof p === "string" ? path.basename(p) : "");
const firstLine = (s: unknown): string =>
  typeof s === "string" ? s.trim().split(/\r?\n/)[0].slice(0, 1000) : "";

/** Pull the message out of a `git commit -m "…"` command, if present. */
function commitMessage(cmd: string): string | null {
  const m = cmd.match(/-m\s+(['"])([\s\S]*?)\1/) ?? cmd.match(/-m\s+(\S+)/);
  return m ? (m[2] ?? m[1]) : null;
}

function renderToolUse(name: string, input: Record<string, unknown>): RenderedLine {
  const file = base(input.file_path ?? input.path);
  switch (name) {
    case "Read":
      return { icon: "📖", summary: `Reading ${file || "a file"}` };
    case "Glob":
    case "Grep":
      return { icon: "📖", summary: "Searching" };
    case "Edit":
      return { icon: "🔧", summary: `Editing ${file || "a file"}` };
    case "Write":
      if (file === "PROGRESS.md") return { icon: "📝", summary: "Updating PROGRESS.md" };
      if (file === "DONE") return { icon: "✅", summary: "Marking run complete (DONE)" };
      return { icon: "🔧", summary: `Writing ${file || "a file"}` };
    case "Bash": {
      const cmd = typeof input.command === "string" ? input.command : "";
      if (/\bgit\s+commit\b/.test(cmd)) {
        const msg = commitMessage(cmd);
        return { icon: "📝", summary: msg ? `Committing: ${msg}` : "Committing" };
      }
      return { icon: "🖥️", summary: `Running: ${cmd.slice(0, 100)}` };
    }
    default:
      return { icon: "🔧", summary: name };
  }
}

export function renderEvent(ev: ParsedEvent): RenderedLine[] {
  const p = ev.payload as {
    message?: { content?: Array<Record<string, unknown>> };
  };

  if (ev.kind === "assistant" && Array.isArray(p.message?.content)) {
    const out: RenderedLine[] = [];
    for (const c of p.message!.content!) {
      if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
        out.push({ icon: "💭", summary: firstLine(c.text) });
      } else if (c.type === "tool_use" && typeof c.name === "string") {
        out.push(renderToolUse(c.name, (c.input as Record<string, unknown>) ?? {}));
      }
    }
    return out;
  }

  if (ev.kind === "user" && Array.isArray(p.message?.content)) {
    const out: RenderedLine[] = [];
    for (const c of p.message!.content!) {
      if (c.type !== "tool_result") continue;
      const text = typeof c.content === "string" ? c.content : firstLine(JSON.stringify(c.content));
      if (c.is_error) {
        out.push({ icon: "❌", summary: firstLine(text) || "error" });
      } else {
        const sha = text.match(/\b[0-9a-f]{7,40}\b/);
        out.push(sha ? { icon: "✅", summary: `Committed ${sha[0].slice(0, 7)}` } : { icon: "✅", summary: firstLine(text) || "done" });
      }
    }
    return out;
  }

  if (ev.kind === "raw") {
    return [{ icon: "⚠️", summary: firstLine((ev.payload as { line?: string }).line) }];
  }

  // system/init, stream_event partials, result — nothing to render inline.
  return [];
}

/** Format a duration like "4m 12s" (or "12s" under a minute). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** The between-turns divider (R3). */
export function renderTurnDivider(o: {
  turn: number;
  elapsedMs: number;
  costUsd: number;
  resumingInSec: number;
}): string {
  return `─── Turn ${o.turn} complete · ${formatDuration(o.elapsedMs)} · $${o.costUsd.toFixed(2)} · resuming in ${o.resumingInSec}s ───`;
}
