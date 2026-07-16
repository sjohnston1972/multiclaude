# Autonomous Auto-Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make multiclaude's server push an autonomous run's commits to GitHub itself, instead of hoping the model remembers, and show unpushed work in the UI.

**Architecture:** A new `server/autonomous/push.ts` owns all pushing and returns an outcome object rather than throwing. `AutonomousManager` calls it at the turn boundary — where `reconcileLastCommit()` already runs, so it fires however the turn ended — and after each WIP salvage commit. A promise-chain serialiser stops the loop and `kill()`'s background salvage from running git concurrently. The status strip gains an ahead-count; the event log gains a `push` line.

**Tech Stack:** Node 24, TypeScript (strict, NodeNext), Fastify, React 18, Vite 6. Adding vitest 3 as the project's first test runner.

**Spec:** `docs/superpowers/specs/2026-07-16-autonomous-auto-push-design.md`

## Global Constraints

- **Never throw from `push.ts`.** Every exported function returns an outcome. A push failure must never crash or stop a run.
- **`GIT_TERMINAL_PROMPT=0`** in the env of every git call in `push.ts`. Without it an expired credential hangs the run forever waiting for input nobody will type.
- **30s timeout** on `git push`; **5s** on every other git call.
- **A push failure never sets `lastError` and never changes run state.** `lastError` means fatal; a failed push is not.
- **`no-remote` is not an error** and must never render as one.
- TypeScript is `strict`. Server code is ESM with `NodeNext` resolution — **relative imports must carry the `.js` extension** (e.g. `./push.js`), matching every existing file.
- Server tests live beside their source as `server/**/*.test.ts` and are excluded from `tsconfig.server.json`, so `npm run build` never compiles them into `dist/`.
- Never commit with a failing build.

---

### Task 1: `push.ts` and the vitest harness

Adds the test runner (approved addition to the otherwise-fixed stack, scoped to this file only) and the push module itself. These ship together because the tests are the only way to reach `push.ts`'s failure paths — nothing else calls it yet.

**Files:**
- Modify: `package.json` (devDependencies + `test` script)
- Create: `vitest.config.ts`
- Modify: `tsconfig.server.json` (exclude tests from the build)
- Create: `server/autonomous/push.ts`
- Test: `server/autonomous/push.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `pushCurrentBranch(cwd: string): Promise<PushOutcome>`, plus the exported types `PushStatus` and `PushOutcome`. Tasks 2 and 3 import these from `./push.js`.

- [ ] **Step 1: Install vitest**

```bash
npm install -D vitest@^3.0.0
```

- [ ] **Step 2: Add the test script to `package.json`**

In the `"scripts"` block, add `test` after `start`:

```json
  "scripts": {
    "dev": "concurrently -n server,web -c blue,green \"tsx watch server/index.ts\" \"vite\"",
    "build": "tsc -p tsconfig.server.json && vite build",
    "start": "node dist/server/index.js",
    "test": "vitest run"
  },
```

- [ ] **Step 3: Create `vitest.config.ts`**

The root `vite.config.ts` sets `root: "web"`, which would make vitest look for tests under `web/` and load the React plugin. A dedicated `vitest.config.ts` takes precedence and keeps the repo root as root.

```ts
import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts, which sets root:"web" for the
// browser bundle. Server tests run from the repo root in plain Node.
export default defineConfig({
  test: {
    include: ["server/**/*.test.ts"],
    environment: "node",
    // Each test shells out to real git several times; Windows process spawn is slow.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
```

- [ ] **Step 4: Exclude tests from the server build**

`tsconfig.server.json` has `"include": ["server/**/*.ts"]`, which would drag `push.test.ts` into `dist/` and make the production build depend on vitest. Add an `exclude` alongside the existing `include`:

```json
  "include": ["server/**/*.ts"],
  "exclude": ["server/**/*.test.ts"]
```

- [ ] **Step 5: Write the failing tests**

Create `server/autonomous/push.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pushCurrentBranch } from "./push.js";

/** Temp dirs made by this file, cleaned up after each test. */
const dirs: string[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", windowsHide: true }).toString();
}

/** A repo on branch `main` with one commit and a working identity. */
function repoWithCommit(): string {
  const d = tmp("mc-push-");
  execFileSync("git", ["init", "-b", "main", d], { stdio: "pipe", windowsHide: true });
  g(d, "config", "user.email", "test@example.com");
  g(d, "config", "user.name", "Test");
  // Signing would prompt or fail in a bare test environment.
  g(d, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(d, "a.txt"), "one");
  g(d, "add", "-A");
  g(d, "commit", "-m", "first");
  return d;
}

/** A bare repo standing in for origin — no network, no GitHub. */
function bareRemote(): string {
  const d = tmp("mc-origin-");
  execFileSync("git", ["init", "--bare", "-b", "main", d], { stdio: "pipe", windowsHide: true });
  return d;
}

/** A path that does not exist, so any push to it fails fast. */
function deadPath(): string {
  return path.join(os.tmpdir(), "mc-origin-does-not-exist-9e3a");
}

function addCommit(repo: string, name: string): void {
  fs.writeFileSync(path.join(repo, name), name);
  g(repo, "add", "-A");
  g(repo, "commit", "-m", `add ${name}`);
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("pushCurrentBranch", () => {
  it("reports no-remote when the repo has no remote at all", async () => {
    const r = await pushCurrentBranch(repoWithCommit());
    expect(r.status).toBe("no-remote");
    expect(r.ahead).toBeNull();
    expect(r.pushedCount).toBe(0);
  });

  it("creates the upstream branch when there is none", async () => {
    const repo = repoWithCommit();
    const origin = bareRemote();
    g(repo, "remote", "add", "origin", origin);

    const r = await pushCurrentBranch(repo);

    expect(r.status).toBe("pushed");
    expect(r.createdUpstream).toBe(true);
    expect(r.ahead).toBe(0);
    expect(r.branch).toBe("main");
    // origin genuinely has the branch now
    expect(g(origin, "rev-parse", "main").trim()).toHaveLength(40);
  });

  it("pushes new commits when an upstream already exists", async () => {
    const repo = repoWithCommit();
    const origin = bareRemote();
    g(repo, "remote", "add", "origin", origin);
    g(repo, "push", "-u", "origin", "main");
    addCommit(repo, "b.txt");

    const r = await pushCurrentBranch(repo);

    expect(r.status).toBe("pushed");
    expect(r.pushedCount).toBe(1);
    expect(r.ahead).toBe(0);
    expect(r.createdUpstream).toBe(false);
  });

  // The round-trip saving is the point of counting first. Break the remote:
  // an "up-to-date" result can only mean push was never invoked, because a
  // real attempt against a dead path would fail.
  it("returns up-to-date without attempting a push", async () => {
    const repo = repoWithCommit();
    const origin = bareRemote();
    g(repo, "remote", "add", "origin", origin);
    g(repo, "push", "-u", "origin", "main");
    g(repo, "remote", "set-url", "origin", deadPath());

    const r = await pushCurrentBranch(repo);

    expect(r.status).toBe("up-to-date");
    expect(r.pushedCount).toBe(0);
    expect(r.ahead).toBe(0);
  });

  it("reports failure without throwing when the remote is unreachable", async () => {
    const repo = repoWithCommit();
    const origin = bareRemote();
    g(repo, "remote", "add", "origin", origin);
    g(repo, "push", "-u", "origin", "main");
    addCommit(repo, "b.txt");
    g(repo, "remote", "set-url", "origin", deadPath());

    const r = await pushCurrentBranch(repo);

    expect(r.status).toBe("failed");
    expect(r.ahead).toBe(1); // still stranded, and we say so
    expect(r.message).toBeTruthy();
  });

  it("reports a detached HEAD instead of a cryptic git error", async () => {
    const repo = repoWithCommit();
    const origin = bareRemote();
    g(repo, "remote", "add", "origin", origin);
    const sha = g(repo, "rev-parse", "HEAD").trim();
    g(repo, "checkout", sha);

    const r = await pushCurrentBranch(repo);

    expect(r.status).toBe("failed");
    expect(r.message).toContain("detached");
    expect(r.branch).toBeNull();
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — every test errors resolving `./push.js` ("Failed to load url ./push.js" / "Cannot find module"), because the module does not exist yet.

- [ ] **Step 7: Write `server/autonomous/push.ts`**

```ts
import { execFile } from "node:child_process";

/**
 * Pushing an autonomous run's commits off this machine.
 *
 * Until this module existed, pushing was only a sentence in the run prompt
 * (manager.ts AUTONOMOUS_PROMPT) — the model usually did it and sometimes
 * didn't, and nothing noticed. Committing was enforced in code; pushing was
 * a polite request. This makes it a guarantee.
 *
 * Everything here returns an outcome and never throws: a run that can't push
 * must keep working, because its commits are still safe locally.
 */

export type PushStatus = "pushed" | "up-to-date" | "no-remote" | "failed";

export interface PushOutcome {
  status: PushStatus;
  /**
   * Commits this push sent, when the upstream already existed. 0 when
   * createdUpstream is true (the whole branch went — there was no upstream to
   * measure against, so the log line says "new branch" rather than a count).
   */
  pushedCount: number;
  /** Commits still unpushed after the attempt; null when unknowable. 0 on success. */
  ahead: number | null;
  /** True when this push created the branch on GitHub. */
  createdUpstream: boolean;
  /** Git's error tail, on failure only. */
  message: string | null;
  /** Current branch, for the log line; null if detached. */
  branch: string | null;
}

/** A network push can hang on a half-open connection; a run must not hang with it. */
const PUSH_TIMEOUT_MS = 30_000;
/** Local plumbing (rev-parse, rev-list) is instant or broken. */
const QUICK_TIMEOUT_MS = 5_000;

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[], timeout: number): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        timeout,
        windowsHide: true,
        // Nobody is awake to type a username. Without this, an expired
        // credential hangs the run forever instead of failing in a second.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

/** Last non-blank line, which is where git puts the useful part of an error. */
function tailLine(s: string, max = 200): string {
  const lines = s.trim().split(/\r?\n/).filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1].trim().slice(0, max) : "";
}

/** Commits on HEAD that the upstream doesn't have; null if there's no upstream. */
async function countAhead(cwd: string): Promise<number | null> {
  const r = await git(cwd, ["rev-list", "--count", "@{u}..HEAD"], QUICK_TIMEOUT_MS);
  if (!r.ok) return null;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

export async function pushCurrentBranch(cwd: string): Promise<PushOutcome> {
  // 1. No remote at all — not a failure, this repo was never meant to push.
  const remotes = await git(cwd, ["remote"], QUICK_TIMEOUT_MS);
  if (!remotes.ok || !remotes.stdout.trim()) {
    return {
      status: "no-remote",
      pushedCount: 0,
      ahead: null,
      createdUpstream: false,
      message: null,
      branch: null,
    };
  }

  // 2. Detached HEAD — say so plainly rather than passing git's error through.
  const head = await git(cwd, ["symbolic-ref", "-q", "--short", "HEAD"], QUICK_TIMEOUT_MS);
  if (!head.ok || !head.stdout.trim()) {
    return {
      status: "failed",
      pushedCount: 0,
      ahead: null,
      createdUpstream: false,
      message: "HEAD is detached — no branch to push",
      branch: null,
    };
  }
  const branch = head.stdout.trim();

  // 3. No upstream — create the branch on origin. Only ever the branch the run
  //    is already on.
  const upstream = await git(
    cwd,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    QUICK_TIMEOUT_MS,
  );
  if (!upstream.ok) {
    const p = await git(cwd, ["push", "-u", "origin", "HEAD"], PUSH_TIMEOUT_MS);
    if (!p.ok) {
      return {
        status: "failed",
        pushedCount: 0,
        ahead: null,
        createdUpstream: false,
        message: tailLine(p.stderr) || "git push failed",
        branch,
      };
    }
    return {
      status: "pushed",
      pushedCount: 0, // the whole branch went; see the field's doc comment
      ahead: (await countAhead(cwd)) ?? 0,
      createdUpstream: true,
      message: null,
      branch,
    };
  }

  // 4. Upstream exists. Count first: it tells us whether to push at all, and
  //    how many commits went. Don't string-match "Everything up-to-date" —
  //    the count answers it and doesn't break when git's wording changes.
  const before = await countAhead(cwd);
  if (before === 0) {
    return {
      status: "up-to-date",
      pushedCount: 0,
      ahead: 0,
      createdUpstream: false,
      message: null,
      branch,
    };
  }

  const p = await git(cwd, ["push"], PUSH_TIMEOUT_MS);
  if (!p.ok) {
    return {
      status: "failed",
      pushedCount: 0,
      ahead: before,
      createdUpstream: false,
      message: tailLine(p.stderr) || "git push failed",
      branch,
    };
  }
  return {
    status: "pushed",
    pushedCount: before ?? 0,
    ahead: (await countAhead(cwd)) ?? 0,
    createdUpstream: false,
    message: null,
    branch,
  };
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 6 passed.

- [ ] **Step 9: Verify the build still passes**

Run: `npm run build`
Expected: exit 0, and `dist/server/autonomous/push.test.js` does **not** exist (the tsconfig exclude works). Check with:

Run: `ls dist/server/autonomous/`
Expected: `push.js` present, no `push.test.js`.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json vitest.config.ts tsconfig.server.json server/autonomous/push.ts server/autonomous/push.test.ts
git commit -m "feat: push.ts — a run's commits reach the remote or say why not"
```

---

### Task 2: The manager pushes at the turn boundary and after salvage

**Files:**
- Modify: `server/autonomous/status.ts` (add `ahead`, `lastPush` to `StatusStrip`)
- Modify: `server/autonomous/manager.ts` (imports, fields, serialiser, `getStatus`, 3 call sites, comment reversal)

**Interfaces:**
- Consumes: `pushCurrentBranch`, `PushStatus`, `PushOutcome` from `./push.js` (Task 1).
- Produces: `StatusStrip.ahead: number | null` and `StatusStrip.lastPush: { status: PushStatus; at: number; message: string | null } | null`, consumed by Task 3 (`renderEvent.ts` reads the `push` event payload, which is a `PushOutcome`) and Task 4 (the web strip).

**Naming trap:** `manager.ts` already has a private `pushEvent(kind, payload)` — it appends to the **event log** and has nothing to do with git. The new method that pushes to git is `pushNow()`. Don't conflate them; `pushNow()` calls `pushEvent("push", out)` and both names are correct.

- [ ] **Step 1: Add the two fields to `StatusStrip`**

In `server/autonomous/status.ts`, add the import at the top and the fields after `lastCommit` (line 13):

```ts
import type { PushStatus } from "./push.js";
```

```ts
  /** Short SHA + subject of HEAD, reconciled with `git log -1` at each turn boundary. */
  lastCommit: { sha: string; subject: string } | null;
  /** Commits the remote doesn't have. null when unknowable (no remote/upstream). */
  ahead: number | null;
  /** The last push attempt, or null before the first one. */
  lastPush: { status: PushStatus; at: number; message: string | null } | null;
```

- [ ] **Step 2: Import the push module in `manager.ts`**

Add after the existing `./status.js` import (line 9):

```ts
import { pushCurrentBranch, type PushStatus } from "./push.js";
```

- [ ] **Step 3: Add the state fields**

In the `--- status-strip fields (R2) ---` block, after `lastCommit` (line 145):

```ts
  private lastCommit: { sha: string; subject: string } | null = null;
  private ahead: number | null = null;
  private lastPush: { status: PushStatus; at: number; message: string | null } | null = null;
  /** "no remote" is worth saying once per run, not once per turn. */
  private notedNoRemote = false;
```

- [ ] **Step 4: Add the git serialiser**

`kill()` fires its salvage in the background without awaiting it while the loop may be at its turn boundary. Two git commands in one repo collide on `index.lock` and one fails — intermittently, at 3am. Add this private helper next to the other git methods, just above `commitPartialWork`:

```ts
  /**
   * Serialise git access. kill() salvages in the background (it must stay sync
   * for its route) while the loop may be at its turn boundary; two concurrent
   * git commands in one repo fight over index.lock and one loses. Queue them.
   *
   * Note the `.then(fn, fn)`: the next operation runs whether or not the
   * previous one rejected — one failed push must not wedge the queue forever.
   */
  private gitQueue: Promise<unknown> = Promise.resolve();
  private git<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.gitQueue.then(fn, fn);
    this.gitQueue = next.catch(() => {});
    return next;
  }
```

- [ ] **Step 5: Add the push + combined helpers**

Add these directly below `reconcileLastCommit` (which ends at line 404). They are the **raw** forms — they must never call `this.git()` themselves, or a helper queued inside `this.git()` would wait on the queue it is already holding and deadlock. Only the call sites in Step 6 wrap.

```ts
  /**
   * Push, then record what happened. Never throws, never sets lastError, never
   * changes run state: stranded commits are a thing to see, not a thing to stop
   * for. Raw — call via this.git().
   */
  private async pushNow(): Promise<void> {
    const out = await pushCurrentBranch(this.config.cwd);
    this.ahead = out.ahead;
    this.lastPush = { status: out.status, at: Date.now(), message: out.message };

    if (out.status === "pushed" || out.status === "failed") {
      this.pushEvent("push", out);
    } else if (out.status === "no-remote" && !this.notedNoRemote) {
      this.notedNoRemote = true;
      this.pushEvent("push", out);
    }
    // "up-to-date" stays silent: the model often pushes first, and a line every
    // turn saying nothing happened is noise.
  }

  /** Turn boundary: what HEAD is, then get it off this machine. Raw — call via this.git(). */
  private async reconcileGit(): Promise<void> {
    await this.reconcileLastCommit();
    await this.pushNow();
  }

  /** Salvage a dying run's work, then get it off this machine. Raw — call via this.git(). */
  private async salvageAndPush(reason: string): Promise<void> {
    await this.commitPartialWork(reason);
    await this.pushNow();
  }
```

- [ ] **Step 6: Wire up the three call sites**

**6a.** In `loop()`, replace line 243. Its position is load-bearing — it stays *above* `if (this.stopped) return;` and above all the success/retry/usage-limit branching, so it fires however the turn ended:

```ts
      const { code } = await this.invokeOnce(resume);
      await this.git(() => this.reconcileGit()); // turn boundary — decisions Q2
      if (this.stopped) return;
```

**6b.** Replace line 312 (the death path):

```ts
      // Salvage before reporting: a dying run must not leave a dirty tree that
      // blocks the next launch's clean-tree pre-flight.
      await this.git(() => this.salvageAndPush(reason));
```

**6c.** Replace line 516 in `kill()`:

```ts
    // Salvage in the background: kill() is sync for the route, and the wip-commit
    // event tells the UI when the tree has been cleaned up.
    void this.git(() => this.salvageAndPush("killed mid-step"));
```

- [ ] **Step 7: Reverse the "deliberately NOT pushed" comment**

`commitPartialWork`'s doc comment (lines 352-353) currently states the opposite of what the code now does. Replace those two lines:

```ts
   * Deliberately NOT pushed: this code is unverified by definition, and the
   * discipline only pushes steps that passed their own check.
```

with:

```ts
   * This IS pushed (via salvageAndPush) — reversing an earlier call not to.
   * The reasoning was that unverified code shouldn't leave the machine; the
   * goal is off-machine backup, and a half-finished step from a run that died
   * is the work least affordable to lose. It's labelled `wip:` in its own
   * commit message, so it can't be mistaken for a verified step.
```

- [ ] **Step 8: Add the fields to the status snapshot**

In `getStatus()`, after `lastCommit` (line 172):

```ts
      lastCommit: this.lastCommit,
      ahead: this.ahead,
      lastPush: this.lastPush,
```

- [ ] **Step 9: Verify it compiles**

Run: `npm run build`
Expected: exit 0. If `tsc` reports `StatusStrip` is missing `ahead`/`lastPush` anywhere, that's a real consumer needing Task 4 — note it and continue.

Run: `npm test`
Expected: PASS — 6 passed (Task 1's tests still green).

- [ ] **Step 10: Commit**

```bash
git add server/autonomous/status.ts server/autonomous/manager.ts
git commit -m "feat: the server pushes a run's work, instead of hoping the model does"
```

---

### Task 3: Make the push visible in the event log

**Files:**
- Modify: `server/autonomous/renderEvent.ts`

**Interfaces:**
- Consumes: `PushOutcome` from `./push.js` (Task 1). The `push` event payload emitted by `pushNow()` (Task 2) **is** a `PushOutcome`.
- Produces: nothing consumed by later tasks.

**Why this task exists:** `pushEvent()` (`manager.ts:210`) runs every manager event through `renderEvent`, but `renderEvent` only handles Claude's stream events (`assistant`, `user`, `raw`) and returns `[]` for anything else. Without a case here the push event is invisible, exactly as the existing `wip-commit` and `usage-limit` events already are. (Fixing *those* is out of scope — noted in the spec.)

- [ ] **Step 1: Add the import**

At the top of `server/autonomous/renderEvent.ts`, after the `streamParse.js` import:

```ts
import type { PushOutcome } from "./push.js";
```

- [ ] **Step 2: Add the `push` case**

Insert at the start of `renderEvent`'s body, before the `assistant` check (line 58). It goes first because it returns early on its own event kind and doesn't touch `p`:

```ts
export function renderEvent(ev: ParsedEvent): RenderedLine[] {
  if (ev.kind === "push") {
    const o = ev.payload as PushOutcome;
    const where = o.branch ? `origin/${o.branch}` : "origin";
    switch (o.status) {
      case "pushed":
        return o.createdUpstream
          ? [{ icon: "🚀", summary: `Pushed new branch ${o.branch} to origin` }]
          : [{
              icon: "🚀",
              summary: `Pushed ${o.pushedCount} commit${o.pushedCount === 1 ? "" : "s"} to ${where}`,
            }];
      case "failed":
        return [{
          icon: "⚠️",
          summary: `Push failed: ${o.message ?? "unknown error"} — commits are safe locally, will retry next turn`,
        }];
      case "no-remote":
        return [{ icon: "📡", summary: "No git remote — this run's commits stay on this machine" }];
      default:
        return []; // up-to-date never reaches here; pushNow doesn't emit it
    }
  }

  const p = ev.payload as {
    message?: { content?: Array<Record<string, unknown>> };
  };
  ...
```

(Leave the rest of the function exactly as it is.)

- [ ] **Step 3: Verify it compiles**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add server/autonomous/renderEvent.ts
git commit -m "feat: push events show in the run log instead of vanishing"
```

---

### Task 4: Show unpushed work in the status strip

**Files:**
- Modify: `web/src/AutonomousTab.tsx` (the local `Status` interface at line 22; the strip at line 196)

**Interfaces:**
- Consumes: `StatusStrip.ahead` and `StatusStrip.lastPush` (Task 2), delivered as JSON over the existing status channel.
- Produces: nothing.

**Note:** `AutonomousTab.tsx` declares its own local `Status` interface rather than importing `StatusStrip` from the server. Follow that existing pattern — don't reach across into server types.

- [ ] **Step 1: Extend the local `Status` interface**

In `web/src/AutonomousTab.tsx`, after `lastCommit` (line 26):

```ts
interface Status {
  state: string;
  sessionId: string;
  currentStep: string | null;
  lastCommit: { sha: string; subject: string } | null;
  ahead: number | null;
  lastPush: { status: string; at: number; message: string | null } | null;
  costUsd: number;
  ...
```

- [ ] **Step 2: Add the indicator to the strip**

Directly after the closing `)}` of the existing `status?.lastCommit && (...)` block (line 201), before the cost `<span>`:

```tsx
        {status?.lastPush?.status === "failed" ? (
          <span className="rounded bg-red-950 px-1.5 py-0.5 text-red-300" title={status.lastPush.message ?? "push failed"}>
            push failed
          </span>
        ) : status?.ahead != null && status.ahead > 0 ? (
          <span className="text-amber-400" title="Committed here, but not yet on the remote">
            ⇡ {status.ahead} unpushed
          </span>
        ) : null}
```

Nothing renders when `ahead` is 0 — the healthy case needs no badge, and a green tick every turn is noise.

- [ ] **Step 3: Verify it compiles**

Run: `npm run build`
Expected: exit 0 (this is where `vite build` type-checks the web app).

- [ ] **Step 4: Commit**

```bash
git add web/src/AutonomousTab.tsx
git commit -m "feat: status strip shows commits that haven't reached the remote"
```

---

### Task 5: Verify against a real run, then document

Tests cover `push.ts` only. The wiring — turn boundary, serialiser, strip — is only proven by driving the actual app, which is what `CLAUDE.md` asks for anyway.

**Files:**
- Modify: `README.md` (autonomous-runs section)

- [ ] **Step 1: Full check**

```bash
npm test && npm run build
```
Expected: 6 passed, build exit 0.

- [ ] **Step 2: Drive a real run**

Build the scratch repo:

```bash
gh repo create multiclaude-push-test --private --clone
cd multiclaude-push-test
```

Write `PLAN.md` with two trivially verifiable steps:

```markdown
# Plan: prove auto-push

1. **Create `one.txt` containing the word `one`.**
   **Done when:** `cat one.txt` prints `one`.
   **Commit:** `feat: add one.txt`.

2. **Create `two.txt` containing the word `two`.**
   **Done when:** `cat two.txt` prints `two`.
   **Commit:** `feat: add two.txt`.
```

Write `PROGRESS.md` with just `# Progress` and a goal line, commit both, then launch an autonomous run against the folder from the UI and confirm:

- commits appear on GitHub **without** the model being asked to push
- the log shows 🚀 `Pushed N commits to origin/main`
- the strip shows no unpushed badge while healthy

- [ ] **Step 3: Prove the failure path**

Mid-run, break the remote:

```bash
git -C <scratch-repo> remote set-url origin C:/nope-does-not-exist
```

Confirm: the strip shows a red `push failed`, the log shows the ⚠️ line, **the run keeps working**, and `lastError` stays empty (the run does not enter `error` state). Then restore the URL and confirm the next turn boundary pushes the backlog and the badge clears.

```bash
git -C <scratch-repo> remote set-url origin <real-url>
```

- [ ] **Step 4: Prove the salvage push**

Launch a run, let it start a step, then hit **Kill** in the UI. Confirm the `wip:` commit reaches GitHub — this is the behaviour reversal from the spec, and it's the one most worth seeing with your own eyes.

- [ ] **Step 5: Document it**

Add to `README.md`'s autonomous-runs section (adjust the wording to match the surrounding voice, but keep all four facts):

```markdown
### Your work leaves the machine on its own

multiclaude pushes a run's commits for you. At the end of every turn — and
after a run dies or you kill it mid-step — the server runs `git push` itself,
rather than relying on Claude to remember. If the branch doesn't exist on
GitHub yet, it's created (`git push -u origin HEAD`), always on the branch the
run is already on.

A push that fails never stops a run: the commits are still safe on disk, the
status strip shows a red **push failed** with the reason, and the next turn
tries again. When commits are sitting locally, the strip shows **⇡ N unpushed** —
so "it committed" and "it's backed up" are no longer the same green tick.
```

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: autonomous runs push their own work"
```

---

## Self-review notes

Spec coverage checked section by section: `push.ts` module and its four steps (Task 1), `GIT_TERMINAL_PROMPT=0` and timeouts (Task 1, Global Constraints), git serialiser (Task 2 Step 4), three call sites (Task 2 Step 6), comment reversal at `manager.ts:352` (Task 2 Step 7), `StatusStrip` fields (Task 2 Steps 1/8), `renderEvent` push case with the once-per-run `no-remote` rule (Task 2 Step 5 + Task 3), web strip (Task 4), vitest scoped to `push.ts` with all six cases (Task 1), manual verification (Task 5). No gaps found.

Two spec items deliberately carried as constraints rather than tasks, because they are properties of Task 1's code rather than separate work: "never throws" and "no-remote is not an error".

`pushedCount` is 0 in the `createdUpstream` case — there is no upstream to measure against before the push, so the count would be a guess. The log line says "new branch" instead, and the field's doc comment says so.
