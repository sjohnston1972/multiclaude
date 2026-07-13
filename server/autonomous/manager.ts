import { spawn, execFile, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import readline from "node:readline";
import type { AutonomousConfig, AutonomousEvent, AutonomousState } from "./types.js";

/**
 * AutonomousManager owns one autonomous run's `claude` child process, exactly the
 * way SessionManager owns a pty: the server holds the process, parses its output,
 * buffers recent events in a ring buffer for replay, and fans them out to any
 * attached viewer. The browser is a dumb viewer.
 *
 * Step 2 is the skeleton: a single invocation (running → done on exit 0, → error
 * otherwise). Step 3 wraps invokeOnce() in the supervisor loop (resume, usage-limit
 * sleep, DONE detection, state-file integrity guard).
 */

const EVENT_BUFFER_LIMIT = 2000; // ~most-recent N events kept for replay on reattach

/** The baked-in autonomous run prompt (spec R10) — sent verbatim on every invocation. */
export const AUTONOMOUS_PROMPT = `Read PLAN.md and PROGRESS.md as your first action. Identify the next incomplete
step from PLAN.md. Do exactly that one step. Commit each change with a clear
message referring to the step number. Append a timestamped entry to PROGRESS.md
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
 * `--session-id` (first call, pins the UUID); true uses `--resume` (Step 3+).
 */
export function buildClaudeArgs(config: AutonomousConfig, sessionId: string, resume: boolean): string[] {
  const args = [
    "-p", AUTONOMOUS_PROMPT,
    resume ? "--resume" : "--session-id", sessionId,
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode", "acceptEdits",
    "--allowedTools", allowedTools(config.extraAllowRules),
    "--model", config.model ?? "sonnet",
  ];
  for (const dir of config.addDirs ?? []) args.push("--add-dir", dir);
  if (config.budgetUsd != null) args.push("--max-budget-usd", String(config.budgetUsd));
  return args;
}

/** Terminate the claude process tree (git/npm run as grandchildren) via taskkill — never POSIX signals. */
function killTree(pid: number): void {
  execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
}

export class AutonomousManager {
  readonly sessionId: string;
  private state: AutonomousState = "preflight";
  private events: AutonomousEvent[] = [];
  private seq = 0;
  private eventListeners = new Set<(ev: AutonomousEvent) => void>();
  private stateListeners = new Set<(s: AutonomousState) => void>();
  private child: ChildProcess | null = null;
  private stopped = false;

  constructor(private config: AutonomousConfig) {
    // Pin a UUID at construction so it survives resets and process restarts (spec 3.2).
    this.sessionId = crypto.randomUUID();
  }

  getState(): AutonomousState {
    return this.state;
  }

  /** A snapshot copy of the buffered events (for replay on WebSocket attach). */
  getEvents(): AutonomousEvent[] {
    return this.events.slice();
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
    for (const l of this.stateListeners) l(s);
  }

  private pushEvent(kind: string, payload: unknown): void {
    const ev: AutonomousEvent = { seq: this.seq++, kind, payload, at: Date.now() };
    this.events.push(ev);
    if (this.events.length > EVENT_BUFFER_LIMIT) this.events.shift();
    for (const l of this.eventListeners) l(ev);
  }

  /**
   * Start the run. Step 2: one invocation, then running → done (exit 0) or error.
   * Step 3 replaces the single call with the supervisor loop.
   */
  async start(): Promise<void> {
    if (this.state === "running") return;
    this.stopped = false;
    this.setState("running");
    const code = await this.invokeOnce(false);
    if (this.stopped) return; // stop() already set us elsewhere
    this.setState(code === 0 ? "done" : "error");
  }

  /** Spawn one `claude` invocation, streaming its stream-json into the ring buffer. Resolves with the exit code. */
  private invokeOnce(resume: boolean): Promise<number> {
    return new Promise((resolve) => {
      const { command, args } = this.config.spawn ?? {
        command: "claude",
        args: buildClaudeArgs(this.config, this.sessionId, resume),
      };
      let child: ChildProcess;
      try {
        child = spawn(command, args, {
          cwd: this.config.cwd,
          windowsHide: true,
          // stdin ignored — the Step 1 spike showed claude stalls ~3s per turn
          // waiting on stdin otherwise (reads as B1-style silence).
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        this.pushEvent("spawn-error", { message: (err as Error).message });
        resolve(-1);
        return;
      }
      this.child = child;

      // readline gives correct newline framing regardless of chunk boundaries or
      // line length (decisions Q3) — no hand-rolled buffer to overflow.
      const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
      rl.on("line", (line) => this.ingestLine(line));
      child.stderr!.on("data", (d) => this.pushEvent("stderr", { text: d.toString() }));

      child.on("close", (code) => {
        this.child = null;
        resolve(code ?? -1);
      });
      child.on("error", (err) => {
        this.pushEvent("spawn-error", { message: (err as Error).message });
        this.child = null;
        resolve(-1);
      });
    });
  }

  private ingestLine(line: string): void {
    if (!line.trim()) return;
    try {
      const ev = JSON.parse(line) as { type?: unknown };
      this.pushEvent(typeof ev.type === "string" ? ev.type : "unknown", ev);
    } catch {
      // Never drop a line — surface it as a raw event (decisions Q3). Step 4 formalizes this.
      this.pushEvent("raw", { line });
    }
  }

  /** Stop the run: kill the current invocation's process tree. Session UUID is preserved. */
  stop(): void {
    this.stopped = true;
    if (this.child?.pid) killTree(this.child.pid);
    this.child = null;
  }
}
