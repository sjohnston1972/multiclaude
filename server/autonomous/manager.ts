import { spawn, execFile, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { AutonomousConfig, AutonomousEvent, AutonomousState } from "./types.js";
import { hasBlockers, isUsageLimit, parseResetTime } from "./loop.js";

/**
 * AutonomousManager owns one autonomous run's `claude` child process, the way
 * SessionManager owns a pty: the server holds the process, parses its output,
 * buffers recent events for replay, and fans them out to attached viewers.
 *
 * The supervisor loop (R8): re-read state files, invoke claude (--session-id on
 * the first call, --resume after), sleep 10s and loop on exit 0, sleep-until-reset
 * on a usage limit, error out otherwise, and stop when a DONE file appears. Before
 * every invocation it checks that PLAN.md/PROGRESS.md are still readable — the
 * discipline applied to the supervisor itself: never invoke into a void.
 */

const EVENT_BUFFER_LIMIT = 2000; // most-recent N events kept for replay on reattach
const DEFAULT_TURN_DELAY_MS = 10_000; // pause between successful turns (spec R8)
const RESET_JITTER_MS = 60_000; // spread wake-ups so we don't retry on the exact second

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
 * `--session-id` (first call, pins the UUID); true uses `--resume`.
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
  /** Epoch ms we intend to wake from a usage-limit sleep (null unless sleeping). */
  wakeAt: number | null = null;
  /** Human-readable reason for the last error/blocked stop (null otherwise). */
  lastError: string | null = null;

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

  constructor(private config: AutonomousConfig) {
    // Pin a UUID at construction so it survives resets and process restarts (spec 3.2).
    this.sessionId = config.sessionId ?? crypto.randomUUID();
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

  /** Start (or restart) the supervisor loop. */
  async start(): Promise<void> {
    if (this.looping) return;
    this.stopped = false;
    this.looping = true;
    await this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      // 1. Task complete? DONE + Blockers → blocked; DONE alone → done.
      if (fs.existsSync(path.join(this.config.cwd, "DONE"))) {
        this.setState(this.blockersPresent() ? "blocked" : "done");
        break;
      }
      // 2. Integrity guard — never invoke if the ground truth is gone.
      const problem = this.stateFileProblem();
      if (problem) {
        this.lastError = problem;
        this.setState("error");
        break;
      }
      // 3. One invocation.
      this.setState("running");
      this.turnText = "";
      const resume = this.invoked;
      this.invoked = true;
      const { code } = await this.invokeOnce(resume);
      if (this.stopped) return;

      if (code === 0) {
        await this.delay(this.config.turnDelayMs ?? DEFAULT_TURN_DELAY_MS);
        continue;
      }
      // Non-zero exit: usage limit → sleep until reset; else error.
      if (isUsageLimit(this.turnText)) {
        this.wakeAt = parseResetTime(this.turnText, Date.now()) + Math.floor(Math.random() * RESET_JITTER_MS);
        this.setState("sleeping");
        this.scheduleResume();
        return; // the resume timer re-enters loop()
      }
      this.lastError = `claude exited with code ${code}`;
      this.setState("error");
      break;
    }
    this.looping = false;
  }

  /** null if PLAN.md and PROGRESS.md are both readable, else a reason naming the offending file. */
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

  /** Spawn one `claude` invocation, streaming its stream-json into the ring buffer. Resolves with the exit code. */
  private invokeOnce(resume: boolean): Promise<{ code: number }> {
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
          // stdin ignored — the Step 1 spike showed claude stalls ~3s per turn otherwise.
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        this.pushEvent("spawn-error", { message: (err as Error).message });
        resolve({ code: -1 });
        return;
      }
      this.child = child;

      const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
      rl.on("line", (line) => this.ingestLine(line));
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

  private ingestLine(line: string): void {
    if (!line.trim()) return;
    try {
      const ev = JSON.parse(line) as { type?: unknown; message?: { content?: unknown } };
      const kind = typeof ev.type === "string" ? ev.type : "unknown";
      this.pushEvent(kind, ev);
      // Accumulate human-visible text for usage-limit detection.
      if (kind === "assistant" && Array.isArray(ev.message?.content)) {
        for (const c of ev.message!.content as Array<{ type?: string; text?: string }>) {
          if (c.type === "text" && typeof c.text === "string") this.turnText += " " + c.text;
        }
      } else if (kind === "result") {
        this.turnText += " " + line;
      }
    } catch {
      // Never drop a line — surface it as a raw event (decisions Q3). Step 4 formalizes this.
      this.pushEvent("raw", { line });
      this.turnText += " " + line;
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
}
