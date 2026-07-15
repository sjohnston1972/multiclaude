import { spawn, execFile, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AutonomousConfig, AutonomousEvent, AutonomousState } from "./types.js";
import { hasBlockers, isUsageLimit, nextModel, parseResetTime, tail } from "./loop.js";
import { parseStream, type ParsedEvent } from "./streamParse.js";
import { renderEvent } from "./renderEvent.js";
import { extractStep, parseGitLogLine, type StatusStrip } from "./status.js";

/**
 * AutonomousManager owns one autonomous run's `claude` child process, the way
 * SessionManager owns a pty: the server holds the process, parses its stream-json
 * output server-side into render-ready events, buffers them for replay, derives
 * the R2 status strip, and fans everything out to attached viewers.
 *
 * The supervisor loop (R8): re-read state files, invoke claude (--session-id on
 * the first call, --resume after), sleep 10s and loop on exit 0, sleep-until-reset
 * on a usage limit, error otherwise, stop when a DONE file appears. Before every
 * invocation it checks PLAN.md/PROGRESS.md are still readable — never invoke into
 * a void.
 */

const EVENT_BUFFER_LIMIT = 2000; // most-recent N events kept for replay on reattach
const DEFAULT_TURN_DELAY_MS = 10_000; // pause between successful turns (spec R8)
const RESET_JITTER_MS = 60_000; // spread wake-ups so we don't retry on the exact second
/**
 * Backoff before each same-model retry of a failed turn. A dropped connection
 * mid-response ("API Error: Connection closed mid-response") used to kill a run
 * outright — it's transient, so the first thing to try is simply the same turn
 * again. Only once these are spent does the run downgrade the model.
 */
export const RETRY_BACKOFF_MS = [5_000, 20_000, 60_000];

/** The baked-in autonomous run prompt (spec R10) — sent verbatim on every invocation. */
export const AUTONOMOUS_PROMPT = `Read PLAN.md and PROGRESS.md as your first action. Identify the next incomplete
step from PLAN.md. Do exactly that one step. Commit each change with a clear
message referring to the step number, then push it with \`git push\` so the work
never exists only on this machine — stay on the current branch, don't create one.
If the push fails (no remote, no upstream, auth, rejected), that is NOT a blocker:
note it in PROGRESS.md and carry on. Append a timestamped entry to PROGRESS.md
when the step is verified done. If every step in PLAN.md is complete, create an
empty file called DONE and stop. If the plan is ambiguous or a step cannot be
completed, write a precise Blockers entry in PROGRESS.md, create DONE, and stop.
Always re-read PLAN.md and PROGRESS.md at the start of every turn — never trust
prior context.`;

/** Default scoped Bash allowlist — the tightest set proven to land a commit in the Step 1 spike (Rung A). */
export const DEFAULT_ALLOWED_TOOLS =
  "Read Edit Write Glob Grep Bash(git *) Bash(npm *) Bash(npx *) Bash(node *)";

function allowedTools(extra?: string): string {
  const e = (extra ?? "").trim();
  return e ? `${DEFAULT_ALLOWED_TOOLS} ${e}` : DEFAULT_ALLOWED_TOOLS;
}

/**
 * Build the pinned `claude` args for one invocation. `resume` false uses
 * `--session-id` (first call, pins the UUID); true uses `--resume`.
 */
export function buildClaudeArgs(
  config: AutonomousConfig,
  sessionId: string,
  resume: boolean,
  /** Active model — differs from config.model once the run has downgraded. */
  model?: string,
): string[] {
  const args = [
    "-p", AUTONOMOUS_PROMPT,
    resume ? "--resume" : "--session-id", sessionId,
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode", "acceptEdits",
    "--allowedTools", allowedTools(config.extraAllowRules),
    "--model", model ?? config.model ?? "sonnet",
  ];
  for (const dir of config.addDirs ?? []) args.push("--add-dir", dir);
  if (config.budgetUsd != null) args.push("--max-budget-usd", String(config.budgetUsd));
  return args;
}

/** Terminate the claude process tree (git/npm run as grandchildren) via taskkill — never POSIX signals. */
function killTree(pid: number): void {
  execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
}

/** The minimal WebSocket surface a viewer needs — satisfied by the `ws` package and clients alike. */
interface ViewerSocket {
  readyState: number;
  send(data: string): void;
  on(event: "close", cb: () => void): void;
}

/**
 * Attach a browser viewer to a run: send `ready`, replay the buffered events +
 * current status, then stream live events and status changes until the socket
 * closes. Mirrors SessionManager's attach/replay so "close the browser, come
 * back later" just works.
 */
export function attachAutonomousViewer(ws: ViewerSocket, manager: AutonomousManager): void {
  const OPEN = 1;
  const send = (o: unknown) => {
    if (ws.readyState === OPEN) ws.send(JSON.stringify(o));
  };
  send({ type: "ready", sessionId: manager.sessionId });
  send({ type: "replay", events: manager.getEvents(), status: manager.getStatus() });
  const offEvent = manager.onEvent((event) => send({ type: "event", event }));
  const offState = manager.onState(() => send({ type: "status", status: manager.getStatus() }));
  ws.on("close", () => {
    offEvent();
    offState();
  });
}

export class AutonomousManager {
  readonly sessionId: string;
  wakeAt: number | null = null;
  lastError: string | null = null;
  /** Model actually spawned each turn. Starts at config.model; only ever moves down MODEL_CHAIN. */
  activeModel: string;
  /** Set once the run has downgraded, so the UI can say so instead of quietly using a lesser model. */
  fellBackFrom: string | null = null;
  /** Same-model retries spent on the current model. Reset by a clean turn or a downgrade. */
  private retries = 0;

  private state: AutonomousState = "preflight";
  private events: AutonomousEvent[] = [];
  private seq = 0;
  private eventListeners = new Set<(ev: AutonomousEvent) => void>();
  private stateListeners = new Set<(s: AutonomousState) => void>();
  private child: ChildProcess | null = null;
  private stopped = false;
  private invoked = false; // false → first call uses --session-id; true → --resume
  private looping = false;
  private turnText = ""; // accumulated text for the current turn (limit detection)
  private delayTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;

  // --- status-strip fields (R2) ---
  private readonly startedAt = Date.now();
  private finishedAt: number | null = null; // frozen wall-clock when the run reached a terminal state
  private turnStartAt: number | null = null;
  private currentStep: string | null = null;
  private lastCommit: { sha: string; subject: string } | null = null;
  private costUsd = 0;
  // Accumulated input-token usage across the run, for the cache-hit readout.
  private usage = { cacheRead: 0, inputUncached: 0, cacheCreation: 0 };

  constructor(private config: AutonomousConfig) {
    // Pin a UUID at construction so it survives resets and process restarts (spec 3.2).
    this.sessionId = config.sessionId ?? crypto.randomUUID();
    // A relaunch resumes an existing session, so the first call must use --resume.
    this.invoked = config.startResumed ?? false;
    this.activeModel = config.model ?? "sonnet";
  }

  getState(): AutonomousState {
    return this.state;
  }

  getEvents(): AutonomousEvent[] {
    return this.events.slice();
  }

  /** The R2 status strip snapshot. */
  getStatus(): StatusStrip {
    return {
      state: this.state,
      sessionId: this.sessionId,
      currentStep: this.currentStep,
      lastCommit: this.lastCommit,
      costUsd: this.costUsd,
      cacheHitPct: (() => {
        const total = this.usage.cacheRead + this.usage.inputUncached + this.usage.cacheCreation;
        return total > 0 ? Math.round((this.usage.cacheRead / total) * 100) : null;
      })(),
      turnElapsedMs: this.state === "running" && this.turnStartAt ? Date.now() - this.turnStartAt : 0,
      totalElapsedMs: (this.finishedAt ?? Date.now()) - this.startedAt,
      wakeAt: this.wakeAt,
      lastError: this.lastError,
      activeModel: this.activeModel,
      fellBackFrom: this.fellBackFrom,
    };
  }

  onEvent(fn: (ev: AutonomousEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  onState(fn: (s: AutonomousState) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private setState(s: AutonomousState): void {
    this.state = s;
    // Freeze the total-elapsed clock when the run reaches a terminal state; unfreeze on (re)launch.
    if (s === "done" || s === "blocked" || s === "error") this.finishedAt = Date.now();
    else if (s === "running") this.finishedAt = null;
    for (const l of this.stateListeners) l(s);
  }

  private pushEvent(kind: string, payload: unknown): void {
    const ev: AutonomousEvent = {
      seq: this.seq++,
      kind,
      payload,
      rendered: renderEvent({ kind, payload }),
      at: Date.now(),
    };
    this.events.push(ev);
    if (this.events.length > EVENT_BUFFER_LIMIT) this.events.shift();
    for (const l of this.eventListeners) l(ev);
  }

  async start(): Promise<void> {
    if (this.looping) return;
    this.stopped = false;
    this.looping = true;
    await this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (fs.existsSync(path.join(this.config.cwd, "DONE"))) {
        this.setState(this.blockersPresent() ? "blocked" : "done");
        break;
      }
      const problem = this.stateFileProblem();
      if (problem) {
        this.lastError = problem;
        this.setState("error");
        break;
      }
      this.setState("running");
      this.turnText = "";
      this.turnStartAt = Date.now();
      const resume = this.invoked;
      this.invoked = true;
      const { code } = await this.invokeOnce(resume);
      await this.reconcileLastCommit(); // turn boundary — decisions Q2
      if (this.stopped) return;

      if (code === 0) {
        this.retries = 0;
        await this.delay(this.config.turnDelayMs ?? DEFAULT_TURN_DELAY_MS);
        continue;
      }

      // Failure ladder: retry the same model, then downgrade, then sleep/stop.
      // Retrying first is what saves a run from a transient API error — the
      // failure we've actually observed killing one. Only a failure that
      // survives every retry is treated as the model being unavailable, so a
      // network blip can no longer masquerade as exhausted credits.
      const reason = isUsageLimit(this.turnText) ? "usage limit" : `exit ${code}`;
      const backoff = this.config.retryBackoffMs ?? RETRY_BACKOFF_MS;
      if (this.retries < backoff.length) {
        const waitMs = backoff[this.retries];
        this.retries++;
        this.pushEvent("turn-retry", {
          model: this.activeModel,
          attempt: this.retries,
          of: backoff.length,
          waitMs,
          reason,
          detail: tail(this.turnText),
        });
        await this.delay(waitMs);
        if (this.stopped) return;
        continue;
      }

      const downgrade = nextModel(this.activeModel);
      if (downgrade) {
        this.pushEvent("model-fallback", {
          from: this.activeModel,
          to: downgrade,
          reason,
          detail: tail(this.turnText),
        });
        this.fellBackFrom ??= this.activeModel;
        this.activeModel = downgrade;
        this.retries = 0; // the new model gets its own retry allowance
        continue;
      }

      if (isUsageLimit(this.turnText)) {
        this.wakeAt = parseResetTime(this.turnText, Date.now()) + Math.floor(Math.random() * RESET_JITTER_MS);
        this.setState("sleeping");
        this.scheduleResume();
        return;
      }
      // Salvage before reporting: a dying run must not leave a dirty tree that
      // blocks the next launch's clean-tree pre-flight.
      await this.commitPartialWork(reason);
      // Never fail blank: the output tail is the only clue to an unrecognised stop.
      this.lastError = `claude (${this.activeModel}) exited with code ${code} after ${backoff.length} retries and no model left to fall back to: ${tail(this.turnText)}`;
      this.setState("error");
      break;
    }
    this.looping = false;
  }

  private stateFileProblem(): string | null {
    for (const name of ["PLAN.md", "PROGRESS.md"]) {
      const p = path.join(this.config.cwd, name);
      try {
        fs.accessSync(p, fs.constants.R_OK);
      } catch {
        return `${name} is missing or unreadable at ${this.config.cwd} — stopped instead of running blind.`;
      }
    }
    return null;
  }

  private blockersPresent(): boolean {
    try {
      return hasBlockers(fs.readFileSync(path.join(this.config.cwd, "PROGRESS.md"), "utf8"));
    } catch {
      return false;
    }
  }

  /**
   * Salvage a dying run's half-finished work.
   *
   * A run that died mid-step used to leave its edits uncommitted, which tripped
   * the next launch's clean-tree pre-flight and left Steven to commit or stash by
   * hand. We can't just relax that gate — it's what stops Rollback's
   * `git reset --hard && git clean -fd` from destroying unrelated work — so the
   * dying run cleans up after itself instead: whatever is in the tree becomes one
   * clearly-marked WIP commit. The work stays visible in `git log` rather than
   * lurking as a dirty tree, and the run's rollback tag still reverts it.
   *
   * Deliberately NOT pushed: this code is unverified by definition, and the
   * discipline only pushes steps that passed their own check.
   *
   * Best-effort — a failure here is surfaced as an event and never replaces the
   * original error that killed the run.
   */
  private commitPartialWork(reason: string): Promise<void> {
    return new Promise((resolve) => {
      const cwd = this.config.cwd;
      execFile("git", ["-C", cwd, "status", "--porcelain"], { windowsHide: true }, (err, stdout) => {
        if (err || !stdout.trim()) return resolve(); // not a repo, or nothing to salvage
        const files = stdout.trim().split(/\r?\n/).length;
        const step = this.currentStep ?? "an unknown step";
        const msg =
          `wip: partial ${step} — run aborted (${reason})\n\n` +
          `Auto-committed by multiclaude so the working tree is clean for the next run.\n` +
          `This work was NOT verified and may be half-finished. To discard it, roll the\n` +
          `run back with its launch tag (${this.config.launchTag ?? "see the run's tag"}).`;
        execFile("git", ["-C", cwd, "add", "-A"], { windowsHide: true }, (addErr) => {
          if (addErr) {
            this.pushEvent("wip-commit", { ok: false, message: tail(addErr.message) });
            return resolve();
          }
          execFile("git", ["-C", cwd, "commit", "-m", msg], { windowsHide: true }, (cErr, cOut) => {
            if (cErr) {
              this.pushEvent("wip-commit", { ok: false, message: tail(cErr.message) });
              return resolve();
            }
            this.pushEvent("wip-commit", { ok: true, files, step, reason, detail: tail(cOut) });
            resolve();
          });
        });
      });
    });
  }

  /** Reconcile last-commit from git (decisions Q2 — event-driven, at the turn boundary, not a timer). */
  private reconcileLastCommit(): Promise<void> {
    return new Promise((resolve) => {
      execFile(
        "git",
        ["-C", this.config.cwd, "log", "-1", "--format=%h %s"],
        { timeout: 5000, windowsHide: true },
        (err, stdout) => {
          if (!err) {
            const parsed = parseGitLogLine(stdout);
            if (parsed) this.lastCommit = parsed;
          }
          resolve();
        }
      );
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.delayTimer = setTimeout(resolve, ms);
    });
  }

  private scheduleResume(): void {
    const ms = Math.max(0, (this.wakeAt ?? Date.now()) - Date.now());
    this.resumeTimer = setTimeout(() => {
      if (this.stopped) return;
      this.wakeAt = null;
      this.looping = true;
      void this.loop();
    }, ms);
  }

  private invokeOnce(resume: boolean): Promise<{ code: number }> {
    return new Promise((resolve) => {
      const { command, args } = this.config.spawn ?? {
        command: "claude",
        args: buildClaudeArgs(this.config, this.sessionId, resume, this.activeModel),
      };
      let child: ChildProcess;
      try {
        child = spawn(command, args, {
          cwd: this.config.cwd,
          windowsHide: true,
          // stdin ignored — the Step 1 spike showed claude stalls ~3s per turn otherwise.
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        this.pushEvent("spawn-error", { message: (err as Error).message });
        resolve({ code: -1 });
        return;
      }
      this.child = child;

      // Robust newline framing (streamParse / decisions Q3) — no hand-rolled buffer.
      void parseStream(child.stdout!, (ev) => this.ingest(ev));
      child.stderr!.on("data", (d) => {
        const s = d.toString();
        this.pushEvent("stderr", { text: s });
        this.turnText += " " + s;
      });

      child.on("close", (code) => {
        this.child = null;
        resolve({ code: code ?? -1 });
      });
      child.on("error", (err) => {
        this.pushEvent("spawn-error", { message: (err as Error).message });
        this.child = null;
        resolve({ code: -1 });
      });
    });
  }

  private ingest(ev: ParsedEvent): void {
    this.pushEvent(ev.kind, ev.payload);

    const p = ev.payload as {
      message?: { content?: Array<Record<string, unknown>> };
      total_cost_usd?: number;
      usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    };
    if (ev.kind === "assistant" && Array.isArray(p.message?.content)) {
      for (const c of p.message!.content!) {
        if (c.type === "text" && typeof c.text === "string") {
          this.turnText += " " + c.text;
          const step = extractStep(c.text);
          if (step) this.currentStep = step;
        }
      }
    } else if (ev.kind === "result") {
      this.turnText += " " + JSON.stringify(ev.payload);
      if (typeof p.total_cost_usd === "number") this.costUsd += p.total_cost_usd;
      // Each turn's result carries that turn's cumulative token usage — sum for a run-wide cache-hit %.
      if (p.usage) {
        this.usage.cacheRead += p.usage.cache_read_input_tokens ?? 0;
        this.usage.inputUncached += p.usage.input_tokens ?? 0;
        this.usage.cacheCreation += p.usage.cache_creation_input_tokens ?? 0;
      }
    } else if (ev.kind === "raw") {
      this.turnText += " " + (p as unknown as { line?: string }).line;
    }
  }

  /** Stop the loop and kill the current invocation's process tree. Session UUID is preserved. */
  stop(): void {
    this.stopped = true;
    this.looping = false;
    if (this.delayTimer) clearTimeout(this.delayTimer);
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    if (this.child?.pid) killTree(this.child.pid);
    this.child = null;
  }

  /** R5 Pause: stop cleanly, session preserved. An in-flight turn hasn't committed, so it's safe. */
  pause(): void {
    this.stop();
    this.setState("paused");
  }

  /** R5 Kill: hard stop; the working tree may be mid-step, so mark it inconsistent. */
  kill(): void {
    this.stop(); // kills the process tree first, so nothing is still writing
    this.lastError = "Killed — the working tree may be mid-step; state could be inconsistent.";
    this.setState("error");
    // Salvage in the background: kill() is sync for the route, and the wip-commit
    // event tells the UI when the tree has been cleaned up.
    void this.commitPartialWork("killed mid-step");
  }

  /** R5 Resume: re-enter the loop; the session already exists, so the first call uses --resume. */
  async resume(): Promise<void> {
    if (this.looping) return;
    this.invoked = true;
    await this.start();
  }
}
