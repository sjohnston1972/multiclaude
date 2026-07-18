/**
 * Shared types for the Autonomous tab supervisor.
 *
 * The supervisor is an in-server manager (sibling of SessionManager) that spawns
 * `claude` headless, parses its stream-json output server-side into render-ready
 * events, and streams them to attached browser viewers. See docs/specs/autonomous-tab.md.
 */

/** The state badge shown in the R2 status strip. */
export type AutonomousState =
  | "preflight" // pre-launch checks not yet green
  | "running" // an invocation is in flight
  | "sleeping" // waiting out a usage-limit reset (Step 3)
  | "paused" // operator paused it (R5); resumable via the pinned UUID
  | "blocked" // Claude stopped on an ambiguity (DONE + Blockers)
  | "done" // task complete (DONE, no Blockers)
  | "error"; // non-recoverable failure

/**
 * A parsed, buffered event from the claude stream-json output. Step 2 keeps this
 * minimal — a raw kind + payload; Step 5 (renderEvent) adds the icon + human summary.
 * Server-side parsing means the browser receives ready objects, never raw JSON.
 */
export interface AutonomousEvent {
  /** Monotonic sequence number within a run — orders events and drives replay on reattach. */
  seq: number;
  /** stream-json event type (`system`|`assistant`|`user`|`result`|`stream_event`), or
   *  `"raw"` for a line that wouldn't parse, `"stderr"`/`"spawn-error"` for process channels. */
  kind: string;
  /** The parsed JSON payload, or `{ line }` / `{ text }` / `{ message }` for non-JSON kinds. */
  payload: unknown;
  /** Human-readable render of this event (R3) — icon + summary lines; may be empty. */
  rendered: { icon: string; summary: string }[];
  /** ms since epoch when observed. */
  at: number;
}

/**
 * Everything needed to launch and run one autonomous invocation. The `spawn`
 * override is the test seam: point it at the fake-claude stub for deterministic
 * tests; leave it unset in production to build the real pinned `claude` args.
 */
export interface AutonomousConfig {
  /** Working directory the run operates in (the target git repo). */
  cwd: string;
  /** Reuse a pinned session UUID (relaunch after a restart, R9). Generated if absent. */
  sessionId?: string;
  /** The run's rollback tag — named in the WIP commit so it says how to undo itself. */
  launchTag?: string;
  /** Pause between successful turns, ms (default 10 000). Tests set it small. */
  turnDelayMs?: number;
  /** Relaunch of an existing session: legacy mode's first call uses --resume. Ignored when freshSessionPerTurn is true. */
  startResumed?: boolean;
  /**
   * Mint a new conversation id for every turn instead of resuming one growing
   * session (design 2026-07-18). Default true. The run's own `sessionId` is
   * unaffected — it stays the persistent run identity. Set false to restore the
   * old resuming behaviour for comparison.
   */
  freshSessionPerTurn?: boolean;
  /** Model alias, default `sonnet`. */
  model?: string;
  /**
   * Backoff before each same-model retry of a failed turn. Length = number of
   * retries before the run gives up on this model and downgrades. Tests set it
   * tiny; production uses RETRY_BACKOFF_MS.
   */
  retryBackoffMs?: number[];
  /** Extra directories granted via `--add-dir` (fixes B4). */
  addDirs?: string[];
  /** Optional per-invocation hard cost cap → `--max-budget-usd`. */
  budgetUsd?: number;
  /** Free-text extra Bash allow-rules appended to the default scoped set (R1). */
  extraAllowRules?: string;
  /** Test seam: run this command+args verbatim instead of the real `claude` invocation. */
  spawn?: { command: string; args: string[] };
}

/**
 * A persisted, first-class autonomous tab (R9). Static fields are set at creation;
 * live fields (state, currentStep, costUsd, lastError, lastTurnAt) are refreshed
 * from the manager's status strip whenever the tab is read.
 */
export interface AutonomousRecord {
  id: string;
  taskName: string;
  projectDir: string;
  addDirs: string[];
  model: string;
  budgetUsd: number | null;
  extraAllowRules: string;
  /** Pinned session UUID — resume survives resets and restarts (spec 3.2). */
  sessionId: string;
  /** Rollback tag created at launch (R7); null until launched (Step 15). */
  launchTag: string | null;
  /** Model the live supervisor is spawning now — absent when no supervisor is live. */
  activeModel?: string;
  /** Set when the run has fallen back: the model it was launched with. */
  fellBackFrom?: string | null;
  state: AutonomousState;
  currentStep: string | null;
  startedAt: number;
  lastTurnAt: number | null;
  costUsd: number;
  lastError: string | null;
  /** True when the supervisor isn't live (loaded from disk / stopped) — offer a relaunch. */
  relaunchable?: boolean;
}
