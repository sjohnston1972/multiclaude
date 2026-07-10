import pty from "node-pty";
import { execSync } from "node:child_process";
import os from "node:os";

/**
 * SessionManager owns the real PowerShell processes (via ConPTY).
 * The browser is just a viewer that attaches/detaches — like a console
 * port on a terminal server. Sessions keep running when no browser is
 * attached, and recent output is kept in a ring buffer so a reconnecting
 * browser can replay what it missed.
 */

const SCROLLBACK_LIMIT = 500_000; // ~500 KB of recent output per session

export interface Session {
  id: string;
  pty: pty.IPty;
  shell: string;
  cwd: string;
  createdAt: number;
  /** Ring buffer of recent output chunks; total length capped at SCROLLBACK_LIMIT. */
  scrollback: string[];
  scrollbackLength: number;
  listeners: Set<(data: string) => void>;
  exitListeners: Set<(code: number) => void>;
  exited: boolean;
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
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  /** Return the existing session or spawn a new shell for this id. */
  ensure(id: string, cwd?: string): Session {
    const existing = this.sessions.get(id);
    if (existing && !existing.exited) return existing;

    const workingDir = cwd ?? os.homedir();
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
      scrollback: [],
      scrollbackLength: 0,
      listeners: new Set(),
      exitListeners: new Set(),
      exited: false,
    };

    proc.onData((data) => {
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

    this.sessions.set(id, session);
    return session;
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
}
