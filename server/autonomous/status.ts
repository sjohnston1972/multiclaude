import type { AutonomousState } from "./types.js";

/**
 * The R2 status strip — the one line that answers "is this thing OK" at a glance.
 * Derived server-side from the event stream + a turn-boundary git reconcile.
 */
export interface StatusStrip {
  state: AutonomousState;
  sessionId: string;
  /** e.g. "Step 3/10: Health endpoint" or "Step 1", parsed from Claude's text. */
  currentStep: string | null;
  /** Short SHA + subject of HEAD, reconciled with `git log -1` at each turn boundary. */
  lastCommit: { sha: string; subject: string } | null;
  /** Accumulated USD, summed from `result` events. */
  costUsd: number;
  /** Share of input tokens served from the prompt cache (0-100), null until known. */
  cacheHitPct: number | null;
  /** Time spent in the current turn (0 when not running). */
  turnElapsedMs: number;
  /** Time since the run launched. */
  totalElapsedMs: number;
  /** Epoch ms we intend to wake from a usage-limit sleep, if sleeping. */
  wakeAt: number | null;
  /** Last error/blocked reason, if any. */
  lastError: string | null;
  /** Model spawned for the current turn — may be below the requested one after a fallback. */
  activeModel: string;
  /** The originally-requested model, set only once a fallback has happened. */
  fellBackFrom: string | null;
}

/** Parse a "Step N", "Step N/M", or "Step N/M: Title" mention out of Claude's text. */
export function extractStep(text: string): string | null {
  const m = text.match(/Step\s+(\d+)\s*(?:\/\s*(\d+))?\s*(?::\s*([^\n.]+))?/i);
  if (!m) return null;
  let s = `Step ${m[1]}`;
  if (m[2]) s += `/${m[2]}`;
  if (m[3]?.trim()) s += `: ${m[3].trim()}`;
  return s;
}

/**
 * Parse `git log -1 --format=%h %s` output — short sha, a space, then the subject
 * (which itself may contain spaces, so split on the FIRST space only).
 */
export function parseGitLogLine(out: string): { sha: string; subject: string } | null {
  const t = out.trim();
  if (!t) return null;
  const sp = t.indexOf(" ");
  if (sp === -1) return { sha: t, subject: "" };
  return { sha: t.slice(0, sp), subject: t.slice(sp + 1).trim() };
}
