import pty from "node-pty";
import { execFile, execFileSync, execSync } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { readSessionSpecs, writeSessionSpecs, type SessionSpec } from "./stateStore.js";

/**
 * SessionManager owns the real PowerShell processes (via ConPTY).
 * The browser is just a viewer that attaches/detaches — like a console
 * port on a terminal server. Sessions keep running when no browser is
 * attached, and recent output is kept in a ring buffer so a reconnecting
 * browser can replay what it missed.
 */

const SCROLLBACK_LIMIT = 500_000; // ~500 KB of recent output per session
const KILL_GRACE_MS = 700; // Ctrl-C first, hard kill after this
const BRANCH_REFRESH_MS = 30_000;

export interface Session {
  id: string;
  pty: pty.IPty;
  shell: string;
  cwd: string;
  createdAt: number;
  title: string;
  /** The command typed into the shell at start (e.g. "claude …"), remembered so the session can be restored. */
  initialCommand?: string;
  branch: string | null;
  /** Whether the working directory is inside a git repo (true even before the first commit). */
  isRepo: boolean;
  lastOutputAt: number;
  /** When the shell last rang the terminal bell (\x07) — claude does this when it wants attention. */
  lastBellAt: number;
  /** One-shot hook fired on the first output chunk (used to time the initial command). */
  onFirstOutput?: () => void;
  /** Ring buffer of recent output chunks; total length capped at SCROLLBACK_LIMIT. */
  scrollback: string[];
  scrollbackLength: number;
  listeners: Set<(data: string) => void>;
  exitListeners: Set<(code: number) => void>;
  exited: boolean;
}

export interface SessionInfo {
  id: string;
  title: string;
  branch: string | null;
  isRepo: boolean;
  cwd: string;
  pid: number;
  createdAt: number;
  lastOutputAt: number;
  lastBellAt: number;
  attached: boolean;
}

export interface CreateOptions {
  id?: string;
  cwd?: string;
  /** Typed into the shell shortly after it starts (e.g. "claude"). */
  initialCommand?: string;
}

/**
 * Kill a session's process tree via taskkill instead of pty.kill():
 * node-pty's native kill path can hard-crash the whole server on Windows
 * (ConPTY race, intermittent). taskkill terminates the tree from outside;
 * node-pty then just sees a normal process exit and cleans up safely.
 */
function killTree(pid: number): void {
  execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {
    // exit code 128 = process already gone — fine either way
  });
}

/** Synchronous variant for server shutdown, where async callbacks never run. */
function killTreeSync(pid: number): void {
  try {
    execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 3000,
    });
  } catch {
    // already gone
  }
}

/** Detect the best available shell once at startup: PowerShell 7 if installed, else Windows PowerShell. */
export function detectShell(): { shell: string; friendly: string } {
  try {
    execSync("where.exe pwsh.exe", { stdio: "pipe" });
    return { shell: "pwsh.exe", friendly: "PowerShell 7" };
  } catch {
    return { shell: "powershell.exe", friendly: "Windows PowerShell" };
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private shell: string;
  readonly shellFriendly: string;
  /** True while the server is shutting down — stops us pruning the restore manifest as ptys die. */
  private shuttingDown = false;
  /** Sessions from the last run that aren't live yet — offered to the browser for restore. */
  private restorable: SessionSpec[];
  /** Debounce handle so bursts of create/exit coalesce into one manifest write. */
  private manifestTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const detected = detectShell();
    this.shell = detected.shell;
    this.shellFriendly = detected.friendly;

    // Sessions that were alive when the server last stopped, ready to restore.
    this.restorable = readSessionSpecs();

    // Keep session titles' git branch fresh (cheap: one git call per session).
    const timer = setInterval(() => this.refreshBranches(), BRANCH_REFRESH_MS);
    timer.unref();
  }

  /**
   * Write the restore manifest now: live session specs plus any not-yet-resolved
   * restorable ones. Best-effort — a failed write (e.g. a transient Windows file
   * lock) must never crash the server, and we never write while shutting down
   * (that would clobber the very sessions we want to restore next launch).
   */
  private writeManifestNow(): void {
    if (this.shuttingDown) return;
    try {
      const live: SessionSpec[] = [...this.sessions.values()].map((s) => ({
        id: s.id,
        cwd: s.cwd,
        initialCommand: s.initialCommand,
        title: s.title,
      }));
      const liveIds = new Set(live.map((s) => s.id));
      writeSessionSpecs([...live, ...this.restorable.filter((s) => !liveIds.has(s.id))]);
    } catch (err) {
      console.error("multiclaude: couldn't write the restore manifest:", (err as Error).message);
    }
  }

  /** Coalesce rapid create/exit churn into a single debounced manifest write. */
  private persistManifest(): void {
    if (this.manifestTimer) return;
    this.manifestTimer = setTimeout(() => {
      this.manifestTimer = null;
      this.writeManifestNow();
    }, 250);
    this.manifestTimer.unref?.();
  }

  /** Write any pending manifest changes immediately — call on graceful shutdown. */
  flushManifest(): void {
    if (this.manifestTimer) {
      clearTimeout(this.manifestTimer);
      this.manifestTimer = null;
    }
    this.writeManifestNow();
  }

  /** Restorable sessions from the previous run that aren't already live. */
  restorableSpecs(): SessionSpec[] {
    return this.restorable.filter((s) => !this.sessions.has(s.id));
  }

  /** Respawn every restorable session with its original id + startup command. */
  restore(): Session[] {
    const created = this.restorable
      .filter((s) => !this.sessions.has(s.id))
      .map((s) => this.create({ id: s.id, cwd: s.cwd, initialCommand: s.initialCommand }));
    this.restorable = [];
    this.writeManifestNow(); // resolve the manifest promptly, not on a debounce
    return created;
  }

  /** User chose "start fresh" — forget the restorable set. */
  dismissRestore(): void {
    this.restorable = [];
    this.writeManifestNow();
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => this.info(s));
  }

  info(s: Session): SessionInfo {
    return {
      id: s.id,
      title: s.branch ? `${s.title} (${s.branch})` : s.title,
      branch: s.branch,
      isRepo: s.isRepo,
      cwd: s.cwd,
      pid: s.pty.pid,
      createdAt: s.createdAt,
      lastOutputAt: s.lastOutputAt,
      lastBellAt: s.lastBellAt,
      attached: s.listeners.size > 0,
    };
  }

  create(opts: CreateOptions = {}): Session {
    const id = opts.id ?? crypto.randomUUID().slice(0, 8);
    const workingDir = opts.cwd ?? os.homedir();

    const proc = pty.spawn(this.shell, [], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: workingDir,
      env: process.env as Record<string, string>,
    });

    const session: Session = {
      id,
      pty: proc,
      shell: this.shell,
      cwd: workingDir,
      createdAt: Date.now(),
      title: path.basename(workingDir) || workingDir,
      initialCommand: opts.initialCommand,
      branch: null,
      isRepo: false,
      lastOutputAt: Date.now(),
      lastBellAt: 0,
      scrollback: [],
      scrollbackLength: 0,
      listeners: new Set(),
      exitListeners: new Set(),
      exited: false,
    };

    proc.onData((data) => {
      session.lastOutputAt = Date.now();
      if (data.includes("\x07")) session.lastBellAt = Date.now();
      if (session.onFirstOutput) {
        const cb = session.onFirstOutput;
        session.onFirstOutput = undefined;
        cb();
      }
      // Append to the ring buffer, trimming oldest chunks past the cap.
      session.scrollback.push(data);
      session.scrollbackLength += data.length;
      while (session.scrollbackLength > SCROLLBACK_LIMIT && session.scrollback.length > 1) {
        const dropped = session.scrollback.shift()!;
        session.scrollbackLength -= dropped.length;
      }
      for (const listener of session.listeners) listener(data);
    });

    proc.onExit(({ exitCode }) => {
      session.exited = true;
      for (const listener of session.exitListeners) listener(exitCode);
      this.sessions.delete(id);
      // A session that ends during normal operation (user killed it or typed
      // exit) shouldn't be restored later — drop it from the manifest. During
      // shutdown we keep it, so it's there to restore next launch.
      if (!this.shuttingDown) this.persistManifest();
    });

    if (opts.initialCommand) {
      // Type the command once the shell has printed its first output (the
      // prompt is ready), after a short settle delay — more reliable than a
      // fixed wait. A 3s deadline is the fallback if no output ever arrives.
      const cmd = opts.initialCommand;
      let typed = false;
      const typeOnce = () => {
        if (typed || session.exited) return;
        typed = true;
        proc.write(`${cmd}\r`);
      };
      session.onFirstOutput = () => setTimeout(typeOnce, 400);
      setTimeout(typeOnce, 3000);
    }

    this.sessions.set(id, session);
    this.persistManifest();
    this.refreshGit(session);
    return session;
  }

  /** Return the existing session or spawn a new shell with this id (used on reattach after a server restart). */
  ensure(id: string, cwd?: string): { session: Session; created: boolean } {
    const existing = this.sessions.get(id);
    if (existing && !existing.exited) return { session: existing, created: false };
    return { session: this.create({ id, cwd }), created: true };
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (s && !s.exited) s.pty.write(data);
  }

  /** Write the same data to every live session (used by "broadcast to all"). */
  writeAll(data: string): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (!s.exited) {
        s.pty.write(data);
        n++;
      }
    }
    return n;
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s || s.exited) return;
    if (cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000) {
      s.pty.resize(cols, rows);
    }
  }

  /**
   * Attach a viewer: returns buffered scrollback for replay plus an
   * unsubscribe function. Live output flows to onData until detached.
   */
  attach(
    id: string,
    onData: (data: string) => void,
    onExit: (code: number) => void
  ): { scrollback: string; detach: () => void } {
    const s = this.sessions.get(id);
    if (!s) return { scrollback: "", detach: () => {} };
    s.listeners.add(onData);
    s.exitListeners.add(onExit);
    return {
      scrollback: s.scrollback.join(""),
      detach: () => {
        s.listeners.delete(onData);
        s.exitListeners.delete(onExit);
      },
    };
  }

  /**
   * Graceful kill: Ctrl-C first (lets claude/git clean up), hard kill shortly
   * after. Resolves when the process has actually exited (bounded at 3s), so
   * callers can report an accurate session list the moment we respond.
   */
  kill(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(hardKill);
        clearTimeout(bail);
        s.exitListeners.delete(finish);
        resolve(true);
      };
      s.exitListeners.add(finish);
      try {
        s.pty.write("\x03");
      } catch {
        // already gone
      }
      const hardKill = setTimeout(() => {
        if (!s.exited) killTree(s.pty.pid);
      }, KILL_GRACE_MS);
      // Safety net: if the process somehow never reports exit, make a final
      // kill attempt and forget the session anyway, so the session list can't
      // show a zombie that has really been killed.
      const bail = setTimeout(() => {
        if (!s.exited) {
          killTree(s.pty.pid);
          this.sessions.delete(id);
        }
        finish();
      }, 3000);
    });
  }

  /**
   * Kill every session — used on server shutdown (sync: exit follows
   * immediately). Sets shuttingDown so the exit handlers keep these sessions in
   * the restore manifest instead of pruning them.
   */
  killAll(): void {
    this.shuttingDown = true;
    for (const s of this.sessions.values()) {
      if (!s.exited) killTreeSync(s.pty.pid);
    }
    this.sessions.clear();
  }

  private refreshBranches(): void {
    for (const s of this.sessions.values()) this.refreshGit(s);
  }

  /** Detect whether cwd is a git repo and, if so, its current branch. */
  private refreshGit(s: Session): void {
    execFile(
      "git",
      ["-C", s.cwd, "rev-parse", "--is-inside-work-tree"],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (s.exited) return;
        s.isRepo = !err && stdout.trim() === "true";
        if (!s.isRepo) {
          s.branch = null;
          return;
        }
        execFile(
          "git",
          ["-C", s.cwd, "branch", "--show-current"],
          { timeout: 5000, windowsHide: true },
          (e2, out2) => {
            if (s.exited) return;
            s.branch = e2 ? null : out2.trim() || null;
          }
        );
      }
    );
  }
}
