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
  /** Model alias, default `sonnet`. */
  model?: string;
  /** Extra directories granted via `--add-dir` (fixes B4). */
  addDirs?: string[];
  /** Optional per-invocation hard cost cap → `--max-budget-usd`. */
  budgetUsd?: number;
  /** Free-text extra Bash allow-rules appended to the default scoped set (R1). */
  extraAllowRules?: string;
  /** Test seam: run this command+args verbatim instead of the real `claude` invocation. */
  spawn?: { command: string; args: string[] };
}
