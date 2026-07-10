import pty from "node-pty";
import { execFile, execSync } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

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
  branch: string | null;
  lastOutputAt: number;
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
  cwd: string;
  pid: number;
  createdAt: number;
  lastOutputAt: number;
  attached: boolean;
}

export interface CreateOptions {
  id?: string;
  cwd?: string;
  /** Typed into the shell shortly after it starts (e.g. "claude"). */
  initialCommand?: string;
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

  constructor() {
    const detected = detectShell();
    this.shell = detected.shell;
    this.shellFriendly = detected.friendly;

    // Keep session titles' git branch fresh (cheap: one git call per session).
    const timer = setInterval(() => this.refreshBranches(), BRANCH_REFRESH_MS);
    timer.unref();
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
      cwd: s.cwd,
      pid: s.pty.pid,
      createdAt: s.createdAt,
      lastOutputAt: s.lastOutputAt,
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
      branch: null,
      lastOutputAt: Date.now(),
      scrollback: [],
      scrollbackLength: 0,
      listeners: new Set(),
      exitListeners: new Set(),
      exited: false,
    };

    proc.onData((data) => {
      session.lastOutputAt = Date.now();
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
    });

    if (opts.initialCommand) {
      // Give the shell a moment to finish printing its startup banner/prompt
      // before typing the command, exactly as a human would.
      const cmd = opts.initialCommand;
      setTimeout(() => {
        if (!session.exited) proc.write(`${cmd}\r`);
      }, 1500);
    }

    this.sessions.set(id, session);
    this.refreshBranch(session);
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
      const finish = () => {
        clearTimeout(hardKill);
        clearTimeout(bail);
        resolve(true);
      };
      s.exitListeners.add(finish);
      try {
        s.pty.write("\x03");
      } catch {
        // already gone
      }
      const hardKill = setTimeout(() => {
        try {
          if (!s.exited) s.pty.kill();
        } catch {
          // already gone
        }
      }, KILL_GRACE_MS);
      // Never leave the HTTP request hanging even if the exit event is lost.
      const bail = setTimeout(finish, 3000);
    });
  }

  /** Kill every session — used on server shutdown. */
  killAll(): void {
    for (const s of this.sessions.values()) {
      try {
        s.pty.kill();
      } catch {
        // process may already be gone
      }
    }
    this.sessions.clear();
  }

  private refreshBranches(): void {
    for (const s of this.sessions.values()) this.refreshBranch(s);
  }

  private refreshBranch(s: Session): void {
    execFile(
      "git",
      ["-C", s.cwd, "branch", "--show-current"],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (s.exited) return;
        s.branch = err ? null : stdout.trim() || null;
      }
    );
  }
}
