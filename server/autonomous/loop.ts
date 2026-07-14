/**
 * Pure helpers for the supervisor loop (R8): usage-limit detection, reset-time
 * parsing, and Blockers detection. Kept separate from the manager so they're
 * unit-testable without spawning a process.
 */

const LIMIT_RE = /hit your (session|weekly) limit/i;

/** Does this turn's output indicate a usage-limit stop? */
export function isUsageLimit(text: string): boolean {
  return LIMIT_RE.test(text);
}

/** Conservative fallback if we can't parse a concrete reset time — wait an hour. */
export const RESET_FALLBACK_MS = 60 * 60 * 1000;

/**
 * Best-effort reset-time parse from a usage-limit message. Tries an explicit ISO
 * 8601 timestamp, then a bare clock time ("3pm", "4:30pm"); otherwise falls back
 * to now + 1h. We never *bank* on a parse — an unparseable message yields the
 * safe fallback, not a guess (decisions: don't guess when unsure).
 */
export function parseResetTime(text: string, now: number): number {
  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/);
  if (iso) {
    const t = Date.parse(iso[0]);
    if (!Number.isNaN(t) && t > now) return t;
  }
  const clock = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (clock) {
    let h = Number(clock[1]) % 12;
    if (/pm/i.test(clock[3])) h += 12;
    const m = clock[2] ? Number(clock[2]) : 0;
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    let t = d.getTime();
    if (t <= now) t += 24 * 60 * 60 * 1000; // next occurrence
    return t;
  }
  return now + RESET_FALLBACK_MS;
}

/**
 * True when PROGRESS.md carries a *populated* `## Blockers` section — i.e. Claude
 * wrote a real blocker, not just the empty template placeholder. This is the
 * single most important signal in the feature (R4), so it must not fire on the
 * seeded empty section.
 */
/** Placeholders Claude writes to mean "no blockers" — must NOT trip the banner. */
const NO_BLOCKERS = new Set([
  "none",
  "n a",
  "na",
  "no",
  "no blocker",
  "no blockers",
  "no blocker yet",
  "no blockers yet",
  "nothing",
  "nothing yet",
  "none yet",
  "none so far",
  "tbd",
]);

export function hasBlockers(progressText: string): boolean {
  const start = progressText.search(/^##\s+Blockers\b/m);
  if (start === -1) return false;
  const after = progressText.slice(start).replace(/^##\s+Blockers\b[^\n]*\n?/, "");
  const next = after.search(/^##\s/m); // end at the next heading, if any
  const section = next === -1 ? after : after.slice(0, next);
  const body = section.replace(/<!--[\s\S]*?-->/g, "").trim(); // drop HTML-comment guidance
  if (!body) return false;
  // "- (none)", "None.", "N/A", "no blockers yet" etc. are not real blockers.
  const norm = body.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return !NO_BLOCKERS.has(norm);
}
