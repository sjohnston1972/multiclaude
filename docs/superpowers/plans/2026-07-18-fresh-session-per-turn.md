# Fresh Session Per Turn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the autonomous supervisor loop from resuming one ever-growing `claude` conversation, so the cost of a turn no longer depends on how many turns preceded it.

**Architecture:** `AutonomousManager.sessionId` keeps its existing job as the run's persistent identity (written to `.multiclaude/<task>/`, reused on relaunch, shown in status). A *separate* per-turn conversation id is minted for each invocation and passed to `claude` via `--session-id`, replacing `--resume`. A new `turn-begin` event carries that id so the behaviour is observable in tests and in the log.

**Tech Stack:** TypeScript, Node 24, `tsx` for test scripts. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-18-fresh-session-per-turn-design.md`

## Global Constraints

- Windows-first; never use POSIX signals to kill processes (`taskkill` only, already handled in `killTree`).
- No new npm dependencies.
- `npm run build` must pass before any commit. Never commit to main with a failing build.
- Conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`), one concern each.
- Do **not** `git push` — this is an interactive session; Steven pushes when he's ready.
- All test scripts are deterministic: they use the `scripts/_stub/fake-claude.mjs` seam and spend no tokens.
- `freshSessionPerTurn` defaults to **true**. Absent config means fresh sessions.
- The run's pinned `sessionId` UUID must keep flowing unchanged through `launch.ts`, `registry.ts`, `store.ts`, `status.ts` and the WebSocket handshake. Tests in `autonomous-api-test.ts`, `autonomous-persist-test.ts` and `autonomous-relaunch-test.ts` must keep passing untouched.

---

### Task 1: Per-turn conversation id

**Files:**
- Modify: `server/autonomous/types.ts:43-70` (add `freshSessionPerTurn` to `AutonomousConfig`)
- Modify: `server/autonomous/manager.ts:61-81` (`buildClaudeArgs` param rename)
- Modify: `server/autonomous/manager.ts:134` (`invoked` comment), `manager.ts:225-250` (loop), `manager.ts:422-427` (`invokeOnce`)
- Test: `scripts/loop-test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `AutonomousConfig.freshSessionPerTurn?: boolean`
  - `buildClaudeArgs(config: AutonomousConfig, conversationId: string, resume: boolean, model?: string): string[]` — signature unchanged in shape; the second parameter is now the *conversation* id, not necessarily the run id.
  - A new event `kind: "turn-begin"` with payload `{ conversationId: string; model: string; resumed: boolean }`.
  - Test helper `run(cwd, scenario, model?, extra?: Partial<AutonomousConfig>)` in `scripts/loop-test.ts`.

- [ ] **Step 1: Write the failing tests**

In `scripts/loop-test.ts`, extend the import on line 10 to pull in `buildClaudeArgs`:

```ts
import { AutonomousManager, buildClaudeArgs } from "../server/autonomous/manager.js";
```

Change the `run` helper (lines 29-44) to accept config overrides:

```ts
/** Run a scenario to completion (or to a non-running resting state) and return the manager. */
async function run(
  cwd: string,
  scenario: string,
  model?: string,
  extra?: Partial<import("../server/autonomous/types.js").AutonomousConfig>
): Promise<AutonomousManager> {
  const prev = process.env.STUB_SCENARIO;
  process.env.STUB_SCENARIO = scenario;
  const mgr = new AutonomousManager({
    cwd,
    model,
    turnDelayMs: 5,
    retryBackoffMs: [1, 1, 1], // real backoff is 5s/20s/60s — too slow for a test
    spawn: { command: process.execPath, args: [stub] },
    ...extra,
  });
  await mgr.start();
  if (prev === undefined) delete process.env.STUB_SCENARIO;
  else process.env.STUB_SCENARIO = prev;
  return mgr;
}
```

Add these pure-function checks immediately after the existing `tail` check on line 199:

```ts
// --- buildClaudeArgs: fresh mode pins a conversation id, legacy resumes -------
{
  const cfg = { cwd: "/tmp" };
  const fresh = buildClaudeArgs(cfg, "conv-abc", false, "sonnet");
  const i = fresh.indexOf("--session-id");
  check("buildClaudeArgs passes the conversation id to --session-id", i >= 0 && fresh[i + 1] === "conv-abc", JSON.stringify(fresh));
  check("buildClaudeArgs never resumes in fresh mode", !fresh.includes("--resume"), JSON.stringify(fresh));

  const legacy = buildClaudeArgs(cfg, "conv-abc", true, "sonnet");
  check("legacy mode still emits --resume", legacy.includes("--resume"), JSON.stringify(legacy));
  check("legacy mode omits --session-id", !legacy.includes("--session-id"), JSON.stringify(legacy));
}
```

Add these manager checks inside the existing `(e0)` flaky block, immediately before its `fs.rmSync` line (currently line 141). The flaky scenario spawns exactly twice — turn 1 fails, the retry succeeds — which is what makes it the right scenario for asserting the id sequence:

```ts
  const begins = mgr.getEvents().filter((e) => e.kind === "turn-begin");
  const ids = begins.map((e) => (e.payload as any).conversationId as string);
  check("(e0) two turns were begun", begins.length === 2, `begins=${begins.length}`);
  check("(e0) the retry got a fresh conversation id", new Set(ids).size === 2, JSON.stringify(ids));
  check("(e0) turn 1 used the pinned run UUID", ids[0] === mgr.sessionId, `${ids[0]} vs ${mgr.sessionId}`);
  check("(e0) no turn resumed", begins.every((e) => (e.payload as any).resumed === false), JSON.stringify(begins.map((e) => (e.payload as any).resumed)));
  check("(e0) the run identity is unchanged by all this", /^[0-9a-f-]{36}$/.test(mgr.sessionId), mgr.sessionId);
```

Add a new block for the legacy escape hatch, immediately after the `(f)` block (currently ends line 194):

```ts
// --- (h) freshSessionPerTurn:false restores the old resuming behaviour --------
{
  const dir = seedRepo();
  const mgr = await run(dir, "flaky", "fable", { freshSessionPerTurn: false });
  const begins = mgr.getEvents().filter((e) => e.kind === "turn-begin");
  const ids = begins.map((e) => (e.payload as any).conversationId as string);
  check("(h) legacy: two turns were begun", begins.length === 2, `begins=${begins.length}`);
  check("(h) legacy: both turns share the run UUID", new Set(ids).size === 1 && ids[0] === mgr.sessionId, JSON.stringify(ids));
  check("(h) legacy: turn 1 does not resume", (begins[0]?.payload as any)?.resumed === false, JSON.stringify(begins[0]?.payload));
  check("(h) legacy: turn 2 resumes", (begins[1]?.payload as any)?.resumed === true, JSON.stringify(begins[1]?.payload));
  fs.rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx scripts/loop-test.ts`

Expected: FAIL. `buildClaudeArgs` is not yet exported with that meaning so the pure checks may pass by accident, but every `turn-begin` check fails with `begins=0`, and the run exits non-zero reporting failures.

- [ ] **Step 3: Add the config flag**

In `server/autonomous/types.ts`, inside `AutonomousConfig`, replace the `startResumed` entry (lines 52-53) with both fields:

```ts
  /** Relaunch of an existing session: legacy mode's first call uses --resume. Ignored when freshSessionPerTurn is true. */
  startResumed?: boolean;
  /**
   * Mint a new conversation id for every turn instead of resuming one growing
   * session (design 2026-07-18). Default true. The run's own `sessionId` is
   * unaffected — it stays the persistent run identity. Set false to restore the
   * old resuming behaviour for comparison.
   */
  freshSessionPerTurn?: boolean;
```

- [ ] **Step 4: Rename the `buildClaudeArgs` parameter**

In `server/autonomous/manager.ts`, replace the doc comment and signature at lines 57-67:

```ts
/**
 * Build the pinned `claude` args for one invocation. `resume` false uses
 * `--session-id <conversationId>` (fresh mode, and the first call of a legacy
 * run); true uses `--resume`. The conversation id is NOT the run id — see
 * AutonomousManager.sessionId.
 */
export function buildClaudeArgs(
  config: AutonomousConfig,
  conversationId: string,
  resume: boolean,
  /** Active model — differs from config.model once the run has downgraded. */
  model?: string,
): string[] {
```

Then update the args array at line 70 to use the renamed parameter:

```ts
    resume ? "--resume" : "--session-id", conversationId,
```

- [ ] **Step 5: Mint the id in the loop and emit `turn-begin`**

In `server/autonomous/manager.ts`, replace the comment on line 134:

```ts
  private invoked = false; // false → this is the run's first invocation
```

Replace lines 240-242 in `loop()`:

```ts
      // Fresh mode (default): every turn is its own conversation, so cost per
      // turn stays flat instead of growing with the transcript. The run's
      // identity is this.sessionId and is untouched; turn 1 borrows it as its
      // conversation id so .multiclaude/<task>/'s session file names a real one.
      const fresh = this.config.freshSessionPerTurn !== false;
      const resume = fresh ? false : this.invoked;
      const conversationId = fresh && this.invoked ? crypto.randomUUID() : this.sessionId;
      this.invoked = true;
      this.pushEvent("turn-begin", { conversationId, model: this.activeModel, resumed: resume });
      const { code } = await this.invokeOnce(resume, conversationId);
```

- [ ] **Step 6: Thread the id through `invokeOnce`**

In `server/autonomous/manager.ts`, replace lines 422-427:

```ts
  private invokeOnce(resume: boolean, conversationId: string): Promise<{ code: number }> {
    return new Promise((resolve) => {
      const { command, args } = this.config.spawn ?? {
        command: "claude",
        args: buildClaudeArgs(this.config, conversationId, resume, this.activeModel),
      };
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx tsx scripts/loop-test.ts`

Expected: PASS on every check, ending in `ALL PASS` and exit 0. In particular `(e0) the retry got a fresh conversation id` and `(h) legacy: both turns share the run UUID` both pass, proving the flag switches behaviour in both directions.

- [ ] **Step 8: Verify the build and the untouched persistence tests**

Run each and expect exit 0 with no failures:

```bash
npm run build
npx tsx scripts/autonomous-api-test.ts
npx tsx scripts/autonomous-persist-test.ts
npx tsx scripts/autonomous-relaunch-test.ts
```

Expected: all pass unchanged. `autonomous-api-test.ts:40` ("create pins a session UUID") passing is the proof that run identity survived the change.

- [ ] **Step 9: Commit**

```bash
git add server/autonomous/types.ts server/autonomous/manager.ts scripts/loop-test.ts
git commit -m "feat: mint a fresh conversation id per autonomous turn"
```

---

### Task 2: Tell the model its PROGRESS.md entry is the only handoff

**Files:**
- Modify: `server/autonomous/manager.ts:36-46` (`AUTONOMOUS_PROMPT`)
- Test: `scripts/loop-test.ts`

**Interfaces:**
- Consumes: `AUTONOMOUS_PROMPT` (already exported from `manager.ts`).
- Produces: nothing new; the prompt constant gains two sentences.

Under resume, a discovery a turn made but never wrote down survived in context. Under fresh sessions it does not. This closes that gap.

- [ ] **Step 1: Write the failing test**

In `scripts/loop-test.ts`, extend the import on line 10:

```ts
import { AutonomousManager, buildClaudeArgs, AUTONOMOUS_PROMPT } from "../server/autonomous/manager.js";
```

Add this check immediately after the `buildClaudeArgs` block added in Task 1:

```ts
// --- the prompt states the handoff contract fresh sessions depend on ---------
check(
  "prompt says PROGRESS.md is the only channel to the next turn",
  AUTONOMOUS_PROMPT.includes("only thing the next turn will see"),
  AUTONOMOUS_PROMPT.slice(-200)
);
check(
  "prompt still forbids trusting prior context",
  AUTONOMOUS_PROMPT.includes("never trust\nprior context"),
  AUTONOMOUS_PROMPT.slice(-200)
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/loop-test.ts`

Expected: FAIL on `prompt says PROGRESS.md is the only channel to the next turn`, with the tail of the current prompt printed as the extra.

- [ ] **Step 3: Extend the prompt**

In `server/autonomous/manager.ts`, replace the closing two lines of `AUTONOMOUS_PROMPT` (lines 45-46) so the constant now ends:

```ts
Always re-read PLAN.md and PROGRESS.md at the start of every turn — never trust
prior context. Your PROGRESS.md entry is the only thing the next turn will see —
it starts a new session with no memory of this one. Write down anything it needs:
decisions you made, things you discovered, and anything you tried that did not
work.`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx scripts/loop-test.ts`

Expected: `ALL PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/autonomous/manager.ts scripts/loop-test.ts
git commit -m "feat: tell autonomous turns their PROGRESS.md entry is the only handoff"
```

---

### Task 3: Full regression sweep and status doc

**Files:**
- Modify: `docs/autonomous-tab-status.md` (v2 additions section)

**Interfaces:**
- Consumes: everything from Tasks 1-2.
- Produces: nothing consumed by later tasks — this is the closing task.

- [ ] **Step 1: Run the whole deterministic suite**

Run every command, expecting exit 0 and no `FAIL` lines:

```bash
npm run build
npx tsx scripts/loop-test.ts
npx tsx scripts/manager-spawn-test.ts
npx tsx scripts/streamparse-test.ts
npx tsx scripts/renderevent-test.ts
npx tsx scripts/manager-events-test.ts
npx tsx scripts/pathscan-test.ts
npx tsx scripts/autonomous-api-test.ts
npx tsx scripts/autonomous-ws-test.ts
npx tsx scripts/autonomous-files-test.ts
npx tsx scripts/autonomous-persist-test.ts
npx tsx scripts/autonomous-relaunch-test.ts
npx tsx scripts/preflight-test.ts
npx tsx scripts/discipline-test.ts
npx tsx scripts/launch-test.ts
npx tsx scripts/controls-test.ts
npx tsx scripts/scaffold-test.ts
npx tsx scripts/draft-plan-test.ts
npx tsx scripts/autonomous-discovery-test.ts
```

If any fail, stop and fix before continuing. `manager-events-test.ts` and `autonomous-ws-test.ts` are the two most likely to notice the extra `turn-begin` event — if either asserts an exact event count or an exact first-event kind, update that assertion to account for `turn-begin` rather than suppressing the event.

- [ ] **Step 2: Record the change in the status doc**

In `docs/autonomous-tab-status.md`, add this bullet at the end of the "## v2 additions (post-v1, driven by dogfooding)" list, immediately before the line beginning "Server default is now LAN mode":

```markdown
- **Fresh session per turn** — the loop no longer resumes one growing conversation. Each turn
  mints its own conversation id, so per-turn cost is flat instead of quadratic in run length and
  a post-limit wakeup is no longer the most expensive turn of the run. The run's pinned UUID is
  unchanged; `freshSessionPerTurn: false` restores the old behaviour for comparison. Expect the
  cache-hit % gauge to drop sharply — that is the trade, not a regression. Design:
  `docs/superpowers/specs/2026-07-18-fresh-session-per-turn-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/autonomous-tab-status.md
git commit -m "docs: record fresh-session-per-turn in the autonomous status doc"
```

- [ ] **Step 4: Report the live acceptance criteria to Steven**

Do not run this yourself — it costs real tokens and takes a real run. Tell Steven that the deterministic suite proves the mechanism but not the payoff, and that the design's §5 acceptance is:

- per-turn input tokens stay roughly flat across a real multi-step run instead of climbing;
- the run reaches DONE in materially fewer usage-limit sleeps (zero for a mid-sized plan would confirm it outright);
- **falsification** — if turns start repeating work, contradicting earlier decisions, or re-litigating settled questions, then Task 2's prompt change was insufficient and the fallback is a structured "notes for the next turn" section in PROGRESS.md, or a bounded resume-every-N-turns sawtooth.

---

## Notes for the implementer

**Why a `turn-begin` event rather than asserting on the spawn args.** `invokeOnce` uses `this.config.spawn ?? { command: "claude", args: buildClaudeArgs(...) }`. Tests set `config.spawn` to point at `scripts/_stub/fake-claude.mjs`, which means `buildClaudeArgs` is never called in any deterministic test and the real args are unobservable. The event makes the decision visible without adding a test-only code path, and it earns its place in the log independently.

**Why the flaky scenario.** Asserting an id *sequence* needs a scenario that spawns more than once and still terminates. `ok` never terminates (no DONE, loop runs forever); `done` and `delete-plan` spawn once. `flaky` spawns exactly twice — fail then succeed — via a counter file that survives respawns.

**Why turn 1 borrows the run UUID.** `launch.ts:70` writes the pinned UUID into `.multiclaude/<task>/` as the run's session file, and `autonomous-api-test.ts:40` asserts a create pins a UUID. Having turn 1 use it keeps that file naming a conversation that actually existed. Turns 2+ mint their own.

**Deviation from the spec.** Design §3.2 says "the `resume` boolean is removed along with the `invoked` field". This plan keeps both. `invoked` is still needed to distinguish turn 1 (which borrows the run UUID) from turns 2+ (which mint their own), and `resume` is still needed for the `freshSessionPerTurn: false` escape hatch that §3.4 requires. The spec's two requirements are in tension on this point; keeping the fields satisfies both. The spec is otherwise implemented as written.

**Relaunch.** A relaunched run has `startResumed: true` (`registry.ts:148`), so `invoked` starts true and in fresh mode its first turn mints a new id rather than resuming. That is intended: a relaunch just takes a fresh turn, reading state from disk like any other. `startResumed` is now only consulted in legacy mode.
