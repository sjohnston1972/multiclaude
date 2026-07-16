# Autonomous runs push their own work

**Date:** 2026-07-16
**Status:** approved design, not yet implemented

## The problem

Autonomous runs commit reliably but push only sometimes. The work sits on
Steven's laptop instead of reaching GitHub, and nothing in the UI says so.

Pushing today is a *sentence in a prompt*, not code:

- `AUTONOMOUS_PROMPT` (`server/autonomous/manager.ts:36`) asks Claude to
  `git push` after each step.
- The discipline block (`server/autonomous/discipline.ts:32`) repeats the ask in
  the user-global `CLAUDE.md`.
- There is no `git push` anywhere in the server. Every `push` in
  `server/autonomous/` is a JavaScript `array.push()` or the internal
  `pushEvent()`.

Compare that to committing, which *is* enforced in code: `commitPartialWork()`
(`manager.ts:358`) makes the server itself commit a dying run's work. A commit is
guaranteed; a push is a polite request the model can drop.

Both prompts also hand the model an explicit escape hatch — a failed push "is NOT
a blocker: note it in PROGRESS.md and carry on" (`manager.ts:40`,
`discipline.ts:36`). That clause is correct (a missing remote must not kill a
night's work) but it lets pushing be quietly skipped while the run still looks
healthy.

**It is not an auth problem.** The credential helper is `manager` and
`git push --dry-run origin main` succeeds. When a run tries, it works.

**And you cannot see it.** `StatusStrip` (`server/autonomous/status.ts:13`)
tracks `lastCommit` only — a short SHA reconciled from `git log -1` at each turn
boundary. There is no ahead-count and no unpushed indicator. The UI shows a green
`✅ Committed a1b2c3d` whether or not that commit ever left the machine.

## Goal

**Off-machine backup.** A night's work must never be lost to a dead laptop. Push
everything that gets committed, including the unverified WIP salvage commit from
a dying run. Readable remote history is explicitly *not* the goal here.

## Decisions taken

| Question | Decision |
|---|---|
| What is success? | Off-machine backup — push everything committed, WIP included |
| Repeated push failure | Carry on, retry each turn. Never stop a productive run |
| Branch with no upstream | `git push -u origin HEAD` — create it automatically |
| Who owns the push | The server, at the turn boundary. Prompt keeps its push sentence |
| Verification | Add vitest, scoped to `push.ts` only |

### Why the prompt keeps its push sentence

Stripping the push clause from `AUTONOMOUS_PROMPT` would not stop the model
pushing: the discipline block in the user-global `CLAUDE.md` carries the same
instruction and applies to any run in a directory with a PLAN.md, including runs
not launched through multiclaude. A redundant model push is harmless — it prints
"Everything up-to-date". The server push is therefore a **floor**, not an
exclusive owner. Leaving both alone keeps this change small.

### Rejected: a git `post-commit` hook

Pushes on every commit rather than every turn, so it is more frequent. Rejected
because it makes the model's own `git commit` block on the network, it lives
invisibly in `.git/hooks` where nothing tracks it, and it would fire during the
launch sequence's own commits (`launch.ts:45`, `launch.ts:63`) before the run has
started.

## Design

### New module: `server/autonomous/push.ts`

Its own file, not an addition to `manager.ts` — that file is already 525 lines
and the largest in the project. A push has one job and no dependency on the
manager's state.

```ts
export type PushStatus = "pushed" | "up-to-date" | "no-remote" | "failed";

export interface PushOutcome {
  status: PushStatus;
  /** Commits this push sent. 0 for up-to-date/no-remote. Drives the log line. */
  pushedCount: number;
  /** Commits still unpushed after the attempt; null if unknowable. 0 on success. */
  ahead: number | null;
  /** True when this push created the branch on GitHub. */
  createdUpstream: boolean;
  /** Git's error tail, on failure only. */
  message: string | null;
  /** Current branch, for the log line; null if detached. */
  branch: string | null;
}

export async function pushCurrentBranch(cwd: string): Promise<PushOutcome>;
```

Returns an outcome; never throws. Steps:

1. `git remote` — empty means no remote configured. Return `no-remote` with
   `ahead: null` and touch nothing. Not a failure; this repo was never meant to
   push.
2. `git symbolic-ref -q --short HEAD` — failure means detached HEAD. There is no
   branch to push, so return `failed` with the message `HEAD is detached — no
   branch to push` rather than a cryptic git error. Success gives `branch`.
3. `git rev-parse --abbrev-ref --symbolic-full-name @{u}` — does this branch have
   an upstream?
   - **No upstream** → `git push -u origin HEAD`, `createdUpstream: true`. Only
     ever touches the branch the run is already on; never creates a branch
     locally. `pushedCount` is then the ahead-count measured *after* against the
     newly-created upstream (everything on the branch was sent).
   - **Has upstream** → count `git rev-list --count @{u}..HEAD` **first**.
     - `0` → return `up-to-date` **without invoking push at all**. This is the
       common case once the model has already pushed, and skipping it avoids a
       pointless network round trip every single turn.
     - `>0` → that number is `pushedCount`; run `git push`, then re-count for
       `ahead` (`0` on success, unchanged on failure).

Counting before the push is what distinguishes `pushed` from `up-to-date`. Do
**not** string-match git's stderr for "Everything up-to-date" — the count answers
it directly and does not break when git's wording changes or is localised.

Note `@{u}` is the local tracking ref, updated by fetch and push. A run that only
ever pushes keeps it accurate. If it were ever stale, the cost is one redundant
push, which is a harmless no-op.

**Two unattended-safety requirements, both non-negotiable:**

- **`GIT_TERMINAL_PROMPT=0`** in the environment of every git call. If cached
  credentials ever expire, git would otherwise wait forever for a username nobody
  is there to type, hanging the run. A hang is a far worse failure than an error.
- **A 30-second timeout** on the push. A half-open TCP connection must not stall
  a run.

### Changes to `server/autonomous/manager.ts`

**Serialise git access.** `kill()` fires `commitPartialWork()` in the background
without awaiting it (`manager.ts:514`) while the loop may be at its turn boundary.
Two concurrent git commands in one repo collide on `index.lock` and one fails —
an intermittent 3am bug. Add a promise-chain serialiser that every git operation
queues onto:

```ts
private gitQueue: Promise<unknown> = Promise.resolve();
private git<T>(fn: () => Promise<T>): Promise<T> {
  const next = this.gitQueue.then(fn, fn);
  this.gitQueue = next.catch(() => {});
  return next;
}
```

**Three call sites:**

1. **Turn boundary** — widen `reconcileLastCommit()` (`manager.ts:243`) into
   `reconcileGit()`: read `git log -1`, push, record the ahead-count. Its
   position is load-bearing and must not move: it sits *above* the
   `if (this.stopped) return;` on line 244 and above all the success / retry /
   usage-limit branching, so it fires however the turn ended — success, transient
   error, a usage limit at 2am, or a pause.
2. **After the death salvage** — `manager.ts:312`, following
   `commitPartialWork(reason)`.
3. **After the kill salvage** — `manager.ts:516`, following
   `commitPartialWork("killed mid-step")`.

Sites 2 and 3 break out of or never return to the loop, so they would never reach
the turn boundary. This **reverses the "Deliberately NOT pushed" decision at
`manager.ts:352`**. That comment's reasoning was that unverified code should not
leave the machine; the backup goal overrides it. A half-finished step from a run
that died is the work least affordable to lose, and it is already labelled `wip:`
in its commit message. Update that comment to record the reversal.

### Changes to `server/autonomous/status.ts`

```ts
/** Commits GitHub doesn't have; null when unknowable (no remote/upstream). */
ahead: number | null;
/** The last push attempt, or null before the first one. */
lastPush: { status: PushStatus; at: number; message: string | null } | null;
```

### Changes to `server/autonomous/renderEvent.ts`

`pushEvent()` (`manager.ts:210`) runs every manager event through `renderEvent`,
but `renderEvent` only handles Claude's stream events (`assistant`, `user`,
`raw`) and returns `[]` for anything else. **Existing `wip-commit` and
`usage-limit` events therefore render to nothing** — they appear only in the raw
JSON view. A `push` event needs its own case or it is invisible the same way.

(The pre-existing invisibility of `wip-commit` and `usage-limit` is a real gap but
is **out of scope** here — noted for a future run.)

Add a `push` case:

| status | line |
|---|---|
| `pushed` | 🚀 `Pushed 2 commits to origin/main` |
| `failed` | ⚠️ `Push failed: <reason> — commits are safe locally, will retry next turn` |
| `up-to-date` | *nothing* — every turn where the model already pushed would spam a line |
| `no-remote` | emitted **once per run**, then silent |

The once-per-run rule for `no-remote` needs a `notedNoRemote` boolean on the
manager.

### Changes to `web/src/AutonomousTab.tsx`

Extend the local `Status` interface (line 22) to match `StatusStrip`, and add an
indicator beside the existing commit display (line 196):

- `ahead === 0` → show nothing. The healthy case needs no badge.
- `ahead > 0` → amber `⇡ 3 unpushed`.
- `lastPush.status === "failed"` → red `push failed`, git's message on hover
  (`title`).

## Error handling

A push failure **never** sets `lastError` and **never** changes run state.
`lastError` means fatal; a failed push is not. It surfaces in the strip and the
event log, retries at the next turn boundary, and the run keeps working. This
matches the existing discipline and the decision above.

`no-remote` is not an error at all and must never render as one.

## Verification

**Add vitest** as a dev dependency with an `npm test` script — the first tests in
this project. Scope: `push.ts` only. This is a deliberate, approved addition to
the otherwise-fixed tech stack.

`push.ts` is a function over a real git repo, so tests build throwaway repos in a
temp dir (`fs.mkdtempSync`) and drive the real paths — no mocking of git:

| Case | Setup | Expect |
|---|---|---|
| No remote | `git init`, one commit | `no-remote`, `ahead: null`, nothing thrown |
| No upstream | init + bare remote, never pushed | `pushed`, `createdUpstream: true`, `ahead: 0` |
| Normal push | upstream exists, one new commit | `pushed`, `pushedCount: 1`, `ahead: 0` |
| Up to date | upstream exists, nothing new | `up-to-date`, `pushedCount: 0`, `ahead: 0` |
| Push fails | remote URL points at a dead path | `failed`, `ahead` still >0, message set, nothing thrown |
| Detached HEAD | `git checkout <sha>` | `failed`, message names the detached HEAD |

The up-to-date case must additionally assert that **no push was attempted** —
that is the round-trip saving, and a regression would be silent otherwise. Assert
it by pointing `origin` at a dead path while the branch is already up to date: a
`up-to-date` result proves push was never invoked, since a real attempt would
fail.

A bare repo (`git init --bare`) in a second temp dir serves as `origin` — no
network, no GitHub, fast and hermetic.

**Also required, since tests cover `push.ts` only:**

- `npm run build` passes (tsc + vite).
- Drive a real run against a scratch repo and watch commits appear on GitHub
  without the model being asked to push.
- Break the remote mid-run (`git remote set-url origin <dead>`) and confirm the
  strip shows `push failed`, the run carries on, and it recovers when the URL is
  restored.

## Out of scope

- Making `wip-commit` and `usage-limit` events visible in the log.
- Any change to rollback, the launch tag, or pre-flight.
- Whether DONE itself gets committed.
- A test harness for anything beyond `push.ts`.
