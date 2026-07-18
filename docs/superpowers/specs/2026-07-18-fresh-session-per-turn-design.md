# Fresh session per turn — design

**Date:** 2026-07-18
**Status:** approved for planning
**Area:** `server/autonomous/` (the R8 supervisor loop)

## 1. Problem

An autonomous run currently pins one `claude` conversation for its whole life: the
first turn uses `--session-id <uuid>`, every turn after it uses `--resume`
(`manager.ts:134`, `manager.ts:240-242`). Context therefore grows monotonically —
turn N re-sends the transcript of turns 1..N-1.

Two consequences, one of which is much worse than it first looks.

**Cost is quadratic in run length.** If each step adds roughly `g` tokens of
transcript, turn N costs about `N·g` and the whole run costs `g·N(N+1)/2`. At
`g ≈ 25k`:

| Run length | Resumed (today) | Fresh per turn |
|---|---|---|
| 15 steps | ~3.0M input tokens | ~375k |
| 30 steps | ~11.6M | ~750k |

The exact `g` is a guess; the quadratic-vs-linear shape is not.

**The usage-limit sleep is self-reinforcing.** On a usage limit the loop sleeps
until reset and resumes (`manager.ts:261-270`). It wakes onto a conversation that
is now the largest it has ever been, so the first turn after the sleep is the most
expensive turn of the run. A fresh 5-hour allowance is spent in minutes, the run
sleeps another 5 hours, and wakes fatter still. Each window buys less work than the
one before. Observed effect: a run that should take one sitting takes several days.

Secondarily, a sufficiently long conversation triggers Claude Code's auto-compaction,
which is itself a full-context turn — a premium paid for the right to keep carrying
context the run has been told to ignore.

**The context is redundant.** The baked-in prompt already ends: *"Always re-read
PLAN.md and PROGRESS.md at the start of every turn — never trust prior context"*
(`manager.ts:45`). The discipline is built on state-on-disk — PLAN.md, PROGRESS.md,
DONE and the git history are the baton between turns. The resumed transcript is a
second, costly copy of information that is already durable.

## 2. Goal

Make the cost of a turn independent of how many turns preceded it, without changing
what a turn does or how a run is observed, controlled, or persisted.

Non-goals: changing the discipline itself, the event pipeline, the UI, the rollback
mechanism, or the model-downgrade ladder.

## 3. Design

### 3.1 Separate the two jobs `sessionId` does today

`sessionId` is currently overloaded. It is:

1. the **run's identity** — written to `.multiclaude/<task>/` at launch
   (`launch.ts:70`), persisted in `autonomous.json`, reused on relaunch
   (`registry.ts:146`), surfaced in status (`manager.ts:170`, `status.ts:9`) and
   over the WebSocket handshake (`manager.ts:106`), and asserted by
   `autonomous-api-test.ts:40`; and
2. the **conversation id** passed to `claude`.

The design keeps (1) exactly as it is and stops using it for (2) beyond the first
turn. `AutonomousManager.sessionId` remains the pinned run UUID. Nothing that
persists, displays, or relaunches a run changes.

### 3.2 Mint a conversation id per turn

This section describes the default path (`freshSessionPerTurn` true, §3.4).

Each iteration of `loop()` spawns with `--session-id <fresh uuid>` instead of
`--resume`. The first turn of a brand-new run uses the pinned run UUID as its
conversation id, so `.multiclaude/<task>/`'s session file still names a real
conversation and the existing API assertion holds. Turns 2+ mint a new UUID each.

`buildClaudeArgs` keeps its shape but takes the conversation id for this turn; the
`resume` boolean is removed along with the `invoked` field. The relaunch path
(`manager.ts:152-153`) simplifies: a relaunched run no longer needs to resume, it
just takes its next turn fresh.

Retries and post-sleep wakeups are turns like any other, so they too start fresh.
A turn that died partway leaves its evidence on disk — a commit, a PROGRESS.md
entry, edited files — which is what the retry reads. This is strictly more reliable
than resuming into the tail of a crashed conversation.

### 3.3 Make the handoff contract explicit in the prompt

Under resume, a discovery a turn made but never wrote down survived in context.
Under fresh sessions it does not. The mechanism to carry it already exists — the
mandated timestamped PROGRESS.md entry — but the prompt does not currently say that
the entry is the *only* channel to the next turn.

Append to `AUTONOMOUS_PROMPT` (`manager.ts:36-46`):

> Your PROGRESS.md entry is the only thing the next turn will see — it starts a new
> session with no memory of this one. Write down anything it needs: decisions you
> made, things you discovered, and anything you tried that did not work.

The existing final sentence ("never trust prior context") stays; it is now literally
true rather than an instruction to ignore something present.

### 3.4 Config flag for A/B measurement

Add `freshSessionPerTurn?: boolean` to `AutonomousConfig` (`types.ts:43`),
**defaulting to true**. Setting it false restores today's resume behaviour.

This exists so the change can be measured on a real run rather than taken on faith,
and so there is a one-line retreat if fresh sessions prove worse. The instrument is
already built: the status strip's cache-hit % gauge. It is expected to drop sharply
— that is not a regression, it is the trade being made visible. The number that
matters is wall-clock time to DONE and how many usage-limit sleeps a run takes.

## 4. What this trades away

**Cross-turn prompt caching.** Resumed turns read most of their input from cache;
fresh turns do not. The trade is an uncached ~25k context against a 90%-cached
~400k one. Expected to be a large net win, but it is the one claim here that is
arithmetic rather than observation, which is why §3.4 makes it measurable and §3.5
says what would falsify it.

**Undocumented mid-run knowledge.** Mitigated by §3.3, not eliminated. If a turn
writes a poor PROGRESS.md entry, the next turn is worse off than it would have been
under resume. This is a real regression risk and the main thing to watch on the
first live run.

## 5. Verification

Deterministic (no real `claude`, no tokens):

| Check | Command |
|---|---|
| All TS compiles | `npm run build` |
| Loop behaviour — every turn a fresh id, none use `--resume` | `npx tsx scripts/loop-test.ts` |
| Run identity still pinned and persisted | `npx tsx scripts/autonomous-api-test.ts` |
| Relaunch still reuses the run UUID | `npx tsx scripts/autonomous-relaunch-test.ts` |
| Persistence unchanged | `npx tsx scripts/autonomous-persist-test.ts` |
| Launch sequence unchanged | `npx tsx scripts/launch-test.ts` |

`scripts/loop-test.ts` needs new assertions: consecutive turns are spawned with
different `--session-id` values and no invocation carries `--resume`; a retry after
a failed turn also gets a fresh id; a post-sleep wakeup also gets a fresh id.

Live acceptance — the claim this whole design rests on:

- Run a real multi-step plan with `freshSessionPerTurn` true. Per-turn input tokens
  stay roughly flat across the run instead of climbing.
- The run reaches DONE in materially fewer usage-limit sleeps than the runs that
  motivated this. Zero sleeps for a mid-sized plan would confirm it outright.

**Falsification:** if per-turn cost stays flat but turns visibly repeat work,
contradict earlier decisions, or re-litigate settled questions, then §3.3 is
insufficient and the handoff needs more than a prose instruction — the fallback is
a structured "notes for the next turn" section in PROGRESS.md, or a bounded
resume-every-N-turns sawtooth.

## 6. Rejected alternatives

**Periodic reset (resume for N turns, then start fresh).** A sawtooth: caps the
ceiling while keeping some cache benefit. Rejected as a compromise that adds a
tuning knob without a principled value for it, and that still pays a quadratic cost
within each segment. Kept in reserve as the §5 fallback.

**A "clear context" button / post-run prompt in the UI.** The original request. It
only helps the session *after* a run, whereas the cost is incurred *during* one.
YAGNI once the loop stops accumulating.

**Leaving it alone and lowering the model.** Already tried and explicitly reverted —
a usage limit is account-wide, so downgrading cannot help (`manager.ts:252-260`).
