# Autonomous Tab — Build-Agent Decisions

**Companion to:** `autonomous-tab.md` (the spec) and `autonomous-tab-plan.md` (the plan).
**Author:** build agent
**Date:** 2026-07-13
**Purpose:** Answer the four open questions in spec §8, opinionated, with trade-offs named.
Anything I want Steven to confirm before code is written is flagged **[NEEDS YOUR CALL]**.

These decisions are grounded in the actual multiclaude codebase (Fastify + `ws`, `SessionManager`
owning process lifecycle, JSON state files in `%LOCALAPPDATA%\multiclaude\`, Windows-only,
`taskkill`-based process control) — not generic best practice. Where the spec's language assumes
something that isn't true of this codebase or the installed `claude` CLI, I say so.

---

## Q1 — Where does the supervisor process live?

**Recommendation: an in-server manager class — `AutonomousManager` — that mirrors the existing
`SessionManager`. One `child_process.spawn("claude", …)` per running turn, owned by the Fastify
server process. Not a detached per-tab process, not a container.**

### Reasoning

multiclaude already has exactly this shape and it works: `SessionManager` owns real child
processes (ptys), survives browser refresh/reconnect because the *server* holds them, and streams
output to any attached WebSocket viewer while buffering a ring buffer for replay. The autonomous
supervisor is the same story with a different child (`claude -p` instead of a pty) and a parsed
event stream instead of raw bytes. Reusing the pattern means: the browser stays a dumb viewer,
"close the browser, come back an hour later" (acceptance #3) falls out of the existing
attach/replay mechanism for free, and there is exactly one place that owns process lifecycle and
one shutdown path (`SIGINT`/`SIGTERM` → `killAll`) to extend.

Critically, **the spec already accepts that the supervisor dies with the server** — R9 says "If
the supervisor process died with the server, offer a one-click relaunch — the pinned UUID means
the conversation continues, not restarts." That single sentence rules out the whole reason you'd
reach for a detached process or a container (surviving a server restart). The pinned session UUID
plus commit-per-step discipline *is* the durability mechanism; the OS process is disposable.

### One important divergence from `SessionManager`

The autonomous child must be spawned with `child_process.spawn` and **piped stdout**, *not*
node-pty. We need clean newline-delimited `stream-json` on stdout; a pty would inject TTY control
sequences and reflow, corrupting the JSON. This also sidesteps the node-pty-kill-crashes-the-server
hazard the codebase documents — a piped child is killed with `taskkill /T /F` (claude spawns git,
npm, etc. as grandchildren, so we need the whole tree) with no ConPTY race.

### Trade-offs I am accepting

- **Supervisor stops when the server stops.** A server crash or a machine reboot ends the run.
  Accepted because R9 designs for it (relaunch reuses the UUID). The in-flight turn is discarded,
  not corrupted, because an incomplete turn hasn't committed (see Q on discipline below).
- **All autonomous tabs share one Node event loop.** A pathological parse could in theory starve
  other tabs. Mitigated by using `readline` framing (bounded per-line work) and the server's
  existing `uncaughtException`/`unhandledRejection` "keep the server up" backstop.
- **No process isolation between the run and multiclaude.** Same as today's terminal sessions —
  this app is arbitrary-code-execution by design and single-user. Not a new risk.

**No input needed** — this is the only choice consistent with the existing architecture and R9.

---

## Q2 — How is git state polled cheaply?

**Recommendation: event-driven, not timer-driven. Update last-commit / step / cost from the
`stream-json` events the supervisor is already parsing, and reconcile with a single
`git log -1 --format=%h%x00%s` at each *turn boundary* (when an invocation exits). Add a
lightweight `fs.watch` on `PROGRESS.md` so the R4 side pane refreshes on write. No fixed 2-second
poll.**

### Reasoning

The status strip's expensive field is "last commit," and a commit only ever happens *inside* a
turn — which the supervisor observes directly as a `📝 Committed abc1234` event in the stream, and
which is bounded by turn exit. So the supervisor already knows the moment the interesting thing
changes; a background timer polling `git` every 2 seconds would do work 99% of the time to observe
nothing. Running `git log -1` once when the invocation exits is both cheaper and strictly more
correct (it's the authoritative reconciliation of whatever the event stream implied).

`PROGRESS.md` is the one file that changes on a cadence the supervisor doesn't fully control (Claude
appends to it mid-turn), and the R4 side pane wants it live. `fs.watch` on that single file is the
right tool — it's push, not poll, and it's one watcher per running tab.

### Trade-offs I am accepting

- **`fs.watch` is known-flaky on Windows** (missed events, duplicate events, no events on some
  network drives). Mitigation: treat the watcher as a *hint* that coalesces refreshes, and always
  do an authoritative re-read at each turn boundary regardless. Worst case the side pane lags until
  the turn ends — acceptable, because the turn-boundary read is guaranteed. I explicitly reject
  making correctness depend on `fs.watch` firing.
- **Working-tree-clean detection** (needed by pre-flight R6.2, not the live strip) stays a
  `git status --porcelain` call, run only when pre-flight runs and once at each turn boundary — not
  on a timer.

**No input needed.** If you later want a manual "refresh now" affordance in the strip that's a
trivial add, but it isn't required.

---

## Q3 — Is `stream-json` parsing robust to partial reads?

**Recommendation: don't hand-roll a buffer. Wrap the child's stdout in Node's
`readline.createInterface({ input: child.stdout, crlfDelay: Infinity })` and `JSON.parse` each
`line` event inside a try/catch. On a parse failure, emit a `raw` event carrying the offending line
rather than dropping it silently.**

### Reasoning

The spec's stated worry — "a buffered read can split a line" and "a single event exceeds the
buffer" — is exactly what `readline` exists to remove. It frames arbitrary-length lines correctly
regardless of chunk boundaries; there is no fixed buffer to overflow, so the "event larger than the
buffer" edge case simply doesn't exist. It's boring, stdlib, and battle-tested (it's how most tools
consume `--output-format stream-json`). Hand-rolling `split("\n")` + a carry buffer re-implements
`readline` with more bugs.

The **discipline-preserving** detail: a line that won't `JSON.parse` must become a visible `raw`
event, never a silent drop. Silently swallowing a malformed line is precisely the "paper over a
problem" failure mode the whole feature exists to prevent. A `raw` event also feeds the R3
"Show raw log" toggle for free.

### Edge cases and how they're handled

- **Process dies mid-line** (final line never terminated): `readline` emits it on `close` if
  non-empty; if it's a partial JSON fragment it fails to parse → surfaces as a `raw` event. Fine.
- **A genuinely huge single event** (e.g. a big tool result): `readline` handles it; the only cost
  is memory for that one line, which is inherent to the data, not a framing bug. If we want a guard,
  cap a single line at e.g. 25 MB (matching the server's existing `bodyLimit`) and emit `raw` +
  a warning above that. **[NEEDS YOUR CALL — minor]:** accept an unbounded single line, or cap at
  25 MB? I lean *cap*, consistent with the server body limit.

### Trade-off I am accepting

- `readline` gives me lines, not backpressure control. For a local single-user tool consuming one
  child's stdout that's irrelevant; I'm not going to add manual flow control for a non-problem.

---

## Q4 — State directory naming

**Recommendation: confirm `.multiclaude/<task-name>/` at the repo root for the run's on-disk
bookkeeping (session UUID, launch tag name), gitignored — exactly as the spec proposes. But keep
the *tab record* (R9's persisted object) in multiclaude's own home,
`%LOCALAPPDATA%\multiclaude\autonomous.json`, like every other piece of app state — not in the
user's repo.**

So there are two homes, by ownership:

| Lives in the user's repo (`<repo>/`) | Lives in multiclaude's home (`%LOCALAPPDATA%\multiclaude\`) |
|---|---|
| `PLAN.md`, `PROGRESS.md`, `DONE` (user-facing, spec-mandated, visible) | `autonomous.json` — the R9 tab records (id, task, dirs, uuid, tag, state, step, cost, error) |
| `.multiclaude/<task-name>/session` (the pinned UUID) + launch-tag reference (gitignored) | the event ring buffer for replay (in memory, like scrollback) |

### Reasoning

`.multiclaude/<task-name>/` is a good name: dot-prefixed so it's out of the way, namespaced to the
app, sub-keyed per task so two runs in one repo don't collide, and trivially gitignored with a
single `/.multiclaude/` line. It matches the "state on disk is truth" philosophy for the one datum
that must survive independently of multiclaude — the session UUID — so even a hand-run
`claude --resume $(cat .multiclaude/<task>/session)` works if the app is gone. I'd keep it.

But the R9 *tab* record is multiclaude UI state, not the user's project. Writing it into the user's
repo would pollute their tree and force more `.gitignore` churn; it belongs with `state.json` and
`sessions.json` in `%LOCALAPPDATA%`, using the identical atomic tmp-write-then-rename the codebase
already uses. This split keeps multiclaude from ever committing its own UI bookkeeping into
someone's project history.

### Trade-offs I am accepting

- **Two sources of truth** (repo `session` file + `autonomous.json`). Mitigation: `autonomous.json`
  is authoritative for the tab; the repo `session` file is a write-once mirror of the UUID for
  human/CLI recovery. They're written once at launch and never diverge because the UUID is
  immutable for the life of the run.
- **We mutate the user's `.gitignore`** at launch (add `/.multiclaude/`). This is a write to their
  repo and must be (a) idempotent — never double-add — and (b) covered by the rollback tag, which
  is created *before* it, so Rollback removes it. Pre-flight will show exactly what launch will
  write/commit so it's never a surprise.

### One thing I want to raise, not change

**[NEEDS YOUR CALL — naming]:** the spec's R1 calls the field "Task name" and makes it the
state-dir name; v1 used `.ccrun/`. I'm going with `.multiclaude/<task-name>/`. Confirm you're happy
retiring the `.ccrun` name entirely (I assume yes — it was the throwaway wrapper). If any existing
`.ccrun/` dirs matter, say so and I'll add a one-time migration; otherwise I won't.

---

## Cross-cutting decisions the four questions imply (flagging, not sneaking in)

These aren't new features — they're forced choices that fall out of answering the above against the
real codebase. None expands scope; all are in `autonomous-tab-plan.md`. Calling them out so you can
veto.

1. **`--max-turns` does not exist in your installed `claude` CLI (v2.1.207).** Spec R1 ("Max turns
   per invocation — default 60") and R8 (`--max-turns <configured>`) assume it. It's gone. Per turn,
   Claude runs one agentic session and stops when it decides to — the "one step then stop" bound
   comes from the R10 prompt + the discipline block, not a flag. **My recommendation:** drop the
   "Max turns" field from R1, keep `--max-budget-usd` as the only hard per-invocation cap, and lean
   on the prompt/discipline for step-scoping. This is a **[NEEDS YOUR CALL]** because it removes a
   spec field. It is the first Blocker in the plan.

2. **"Pause = SIGTERM, Kill = SIGKILL" (R5) does not map to Windows.** `child.kill('SIGTERM')` on
   Windows is a hard `TerminateProcess` — there is no graceful-flush signal, and the codebase
   already avoids signals in favour of `taskkill /T /F`. So Pause and Kill are *both* hard kills of
   the claude process tree; they differ only in intent and messaging. **This is safe** precisely
   because of the preserved discipline: a turn that hasn't finished hasn't committed, so killing
   mid-turn discards uncommitted work and the next `--resume` turn re-reads `PLAN.md`/`PROGRESS.md`
   and simply redoes that step. **My recommendation:** Pause = "stop the loop, don't start the next
   turn, `taskkill` the current one"; Kill = same kill but also mark state `error`/inconsistent and
   warn. Flagged as a Blocker because it reinterprets R5's wording.

3. **The exact flag combination that makes non-interactive `git commit` succeed (B2) must be pinned
   by a live test before anything else is built.** `--permission-mode acceptEdits` auto-accepts
   *edits* but Bash still needs an allow-rule — that's B2. `--allowedTools` supports scoped
   `Bash(git *)`. (Correction, per Steven's 2026-07-13 verification: a denied Bash command does **not**
   hang — it lands in the result JSON's `permission_denials` array and Claude reports it. Denials
   surface; they don't stall. So the tight scope is the safe default, not a hang risk.) The plan's
   **Step 1 is a spike** whose only pass condition is "a real commit landed in a throwaway repo,"
   with a documented fallback ladder (`acceptEdits` + scoped `allowedTools` → broaden scope →
   last-resort `--dangerously-skip-permissions`). I will not build the manager until that invocation
   is proven.

4. **Server-side parsing + per-tab event ring buffer** (not client-side JSON parsing). Forced by Q1
   and Q3: the supervisor already parses stream-json to run the loop, so it renders R3 events
   server-side and buffers them for WebSocket replay — identical to `SessionManager`'s scrollback.
   The browser receives ready-to-render event objects, never raw JSON (except via the debug toggle).

---

## Resolutions (2026-07-13, Steven) — supersedes the flags above

Every `[NEEDS YOUR CALL]` in this document is now answered. Recorded so nothing is left open.

- **max-turns (cross-cutting #1):** **dropped.** Steven confirmed it's absent from v2.1.207 in both
  top-level and print-mode help. Spec `autonomous-tab.md` R1 field and R8 line removed;
  `--max-budget-usd` is the only hard per-invocation cap.
- **Windows Pause/Kill (cross-cutting #2):** **confirmed as proposed.** Pause = stop loop + taskkill
  current (resumable); Kill = taskkill + mark inconsistent + warn.
- **Bash scope (cross-cutting #3):** **scoped default + one editable field.** Default
  `Bash(git *) Bash(npm *) Bash(npx *) Bash(node *)`; one free-text "Extra Bash allow-rules" field in
  the new-tab dialog widens it. Denials surface via `permission_denials`, so tight scope is safe.
- **Q3 oversized-line cap:** proceeding with my default — **cap a single line at 25 MB** (matching the
  server `bodyLimit`) and emit a `raw` + warning above it. Not separately vetoed; revisit only if a
  real event legitimately exceeds it.
- **Q4 `.ccrun` retirement:** **retired, no migration.** `.multiclaude/<task-name>/` is the state dir;
  no existing `.ccrun/` dirs need carrying forward.
- **Discipline heading-match (Q4-adjacent / plan Step 13):** pre-flight ensures the *heading* exists
  and never overwrites a shorter live version.
- **New guard added at Steven's request:** a **state-file integrity check** at each turn boundary —
  if `PLAN.md`/`PROGRESS.md` go missing or unreadable mid-run, the supervisor stops with `state =
  error` and the reason, instead of invoking Claude into a void. Folded into plan Step 3.

---

## Proposed scope item — "Draft a plan with Claude" helper (v2)

**Status:** approved to add to scope (Steven, 2026-07-14). Recommendation confirmed: **enabled by
default, flagged "Recommended"** in the launch dialog. Build is pending answers to the sub-questions
at the end — I will not write code for it until those are settled (no-creep rule).

### The gap it closes

A good `PLAN.md` is a complex markdown document, and authoring it is an interactive brainstorming
activity with Claude — that does **not** change with the autonomous workflow (spec R11 + §7:
automatic PLAN.md generation is explicitly out of scope). What v1 ships is only the *empty*
scaffold (R12): the template skeleton with `<placeholders>`, not a real plan. So today the flow has
a seam — you draft `PLAN.md` in a normal terminal tab, then open a separate Autonomous tab pointed
at that repo. This item bridges that seam **without** crossing the "no autonomous plan generation"
line: the human stays in the loop; this is *assisted authoring*, not unattended authoring.

### What it is

In the new-autonomous-run dialog, when `PLAN.md` is missing (pre-flight ❌), the primary offered
action becomes **"Draft a plan with Claude"** — the recommended default — sitting *above* the plain
"Scaffold PLAN.md + PROGRESS.md" button, which stays as the manual/advanced fallback. Choosing it
opens an interactive brainstorming session in the target repo, primed to produce a real `PLAN.md`
that satisfies the plan-template rules (one step = one commit, every step ends in an executable
verify, a STOP boundary). When the human is happy and `PLAN.md` is committed, pre-flight re-runs and
goes green, and Launch proceeds as normal.

### Recommendation (opinionated)

- **Enabled by default and flagged "Recommended."** A run is only as safe as its plan; nudging the
  user toward assisted authoring rather than a blank skeleton is the single highest-leverage nudge
  in the whole feature. The empty scaffold remains for people who already know exactly what they
  want.
- **Interactive, never automatic.** The helper opens a session the human drives — it does not
  silently emit a plan and launch. This preserves §7 and the core discipline: a plan produced with
  no human judgment is exactly the 3 a.m. danger the feature exists to prevent.

### Trade-offs I am accepting

- One more path through the dialog (draft vs scaffold vs bring-your-own) — mitigated by making the
  recommended default obvious and the others clearly secondary.
- It leans on the existing terminal/session infrastructure rather than inventing a new chat surface
  (see sub-question 1) — consistent with the project non-goal "the terminal IS the interface; not an
  AI wrapper."

### Sub-questions to resolve before I build — **[NEEDS YOUR CALL]**

1. **Where does the brainstorming happen?** My recommendation: spawn a **normal multiclaude terminal
   tab** running `claude` in the repo (reuse the whole existing session stack; honours "the terminal
   is the interface"), rather than an embedded bespoke chat pane. Confirm, or say you want it
   in-dialog.
2. **How is it primed?** Recommendation: launch `claude` with an appended plan-authoring system
   prompt + attach `docs/specs/plan-template.md`, so it opens already knowing the rules (executable
   verify per step, ≤3 files per step, STOP boundary). Any priming content you want changed?
3. **Hand-off back to launch.** Recommendation: keep it file-based — the session writes and commits
   `PLAN.md`; the launch dialog just re-runs pre-flight and detects it (simplest, no coupling).
   Acceptable, or do you want a tighter "plan ready → jump back to Launch" handshake?
4. **Scope of assistance.** Just the plan prose, or should it also help choose the invariants block
   and propose the per-step verify commands? Recommendation: yes to both — the verify commands are
   where unattended runs live or die, so helping author them is the most valuable part.
