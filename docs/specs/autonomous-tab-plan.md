# Autonomous Tab — PLAN.md (v1 build: supervisor → events → UI → persistence → pre-flight → controls → onboarding)

Autonomous-run plan for building the Autonomous tab feature described in `autonomous-tab.md`,
with decisions recorded in `autonomous-tab-decisions.md`. Each step is one small, commit-able
chunk that ends in an **executable** verify. Do **one step per turn**, commit with the step number,
append a timestamped line to `PROGRESS.md`. Stop after Step 19, then create `DONE`.

This plan is itself written in the pattern the feature encodes — deliberately, so building it
dogfoods the discipline.

---

## Invariants (apply to every step)

- **Language / modules:** TypeScript, ESM, `NodeNext` resolution. Relative imports carry the `.js`
  suffix in server code (e.g. `import { X } from "./manager.js"`), matching existing `server/*.ts`.
- **Package manager:** npm. No new runtime dependencies without a Blocker being raised first — the
  supervisor uses only Node stdlib (`child_process`, `readline`, `fs`, `crypto`, `os`, `path`).
- **Test runner:** there is no unit framework. Three verify shapes only:
  - **Pure logic / TS module:** `npx tsx scripts/<name>-test.ts` — imports the TS module directly,
    uses the repo's `check(name, cond)` helper, prints `ALL PASS`, `process.exit(0|1)`.
  - **HTTP / integration:** `node scripts/<name>-test.mjs` — hits `http://127.0.0.1:3001`, **server
    must be running** (`npm run dev`), same `check`/`ALL PASS`/exit-code contract.
  - **Build gate:** `npm run build` (runs `tsc -p tsconfig.server.json && vite build`) exits 0.
- **Determinism:** loop/lifecycle tests use a **fake `claude` stub** script (scripted stream-json +
  exit code) so they're deterministic and free. Only Steps 1 and 19 invoke the real `claude` CLI
  and require it to be installed and authenticated; they are marked **[LIVE]**.
- **Error envelope:** on failure `reply.code(4xx|5xx); return { error: "<plain English>" }`. On
  success return the resource JSON or `{ ok: true }`. Never throw to the client; never console-only.
- **Process control:** Windows-only. Terminate the claude process **tree** with `taskkill /pid <pid>
  /T /F` (claude spawns git/npm as grandchildren). Never POSIX signals.
- **Server owns lifecycle:** all new backend code lives under `server/autonomous/` and registers via
  `registerAutonomousRoutes(app)` called from `server/index.ts`. The supervisor is an in-server
  `AutonomousManager` (see decisions Q1) spawning `claude` via `child_process.spawn` with **piped**
  stdout — never node-pty.
- **App state:** the R9 tab records persist to `%LOCALAPPDATA%\multiclaude\autonomous.json` via the
  existing atomic tmp-write-then-rename pattern (`stateStore.ts`). Repo-local `.multiclaude/<task>/`
  holds only the pinned session UUID (see decisions Q4).
- **Claude invocation (pinned, per decisions cross-cutting #1 & #3):** `-p`, `--session-id <uuid>`
  first call then `--resume <uuid>`, `--output-format stream-json`, `--include-partial-messages`,
  `--verbose`, `--allowedTools` including a git-capable Bash rule, `--permission-mode acceptEdits`,
  `--add-dir <each>`, `--model <configured>`, optional `--max-budget-usd`. **No `--max-turns`** — it
  does not exist in the installed CLI (v2.1.207); see Blockers.
- **Branch policy:** all work on `feat/autonomous-tab` (this feature's branch). Conventional commits,
  one commit per step. Never commit with a failing `npm run build`.

---

## Phase 1 — Backend supervisor (process lifecycle)

1. **Pin the claude invocation (spike). [LIVE]** Prove B2/R8 before building anything: in a throwaway
   temp git repo seeded with a one-step `PLAN.md` ("create `hello.txt` containing `hi`, commit"),
   a `PROGRESS.md`, and a temp `CLAUDE.md` carrying the discipline block, run the pinned invocation
   once and assert a commit landed. Files: `scripts/claude-invoke-test.mjs` (+ `scripts/_stub/`
   fixtures if needed).
   **Verify:** `node scripts/claude-invoke-test.mjs` → `ALL PASS` — `git -C <tmp> log --oneline`
   shows exactly one new commit and `hello.txt` exists. If it fails, the script prints which fallback
   rung (`Bash(git *)` scope → broaden → `--dangerously-skip-permissions`) was needed.
   **Commit:** `test: pin claude headless invocation that lands a commit (fixes B2)`.

2. **`AutonomousManager` skeleton + fake-claude stub.** Add a manager that spawns a configurable
   command (defaults to `claude`, overridable so tests point at a stub), tracks `state`
   (`preflight|running|sleeping|blocked|done|error`), holds an in-memory event ring buffer +
   listener set (mirroring `SessionManager`), and exposes `start()` / `stop()`. Add
   `scripts/_stub/fake-claude.mjs` emitting scripted `stream-json` then exiting 0. Files:
   `server/autonomous/manager.ts`, `server/autonomous/types.ts`, `scripts/_stub/fake-claude.mjs`.
   **Verify:** `npx tsx scripts/manager-spawn-test.ts` → `ALL PASS` — start against the stub,
   observe `state` go `running → done` and ≥1 event buffered.
   **Commit:** `feat: AutonomousManager skeleton spawning claude via child_process`.

3. **Supervisor loop.** Implement the R8 loop over the manager: check for `DONE` (→ `done`, exit);
   exit 0 → sleep 10s → re-invoke with `--resume`; exit ≠ 0 → if stderr/stream matches
   `/hit your (session|weekly) limit/` parse reset time → `sleeping` until reset + jitter, else
   `error` + retain last 20 events. First call uses `--session-id`, subsequent `--resume`. Files:
   `server/autonomous/manager.ts`, `server/autonomous/loop.ts`.
   **Verify:** `npx tsx scripts/loop-test.ts` → `ALL PASS` — stub emits (a) a limit message + exit 1
   → asserts `state==="sleeping"` and a computed wake time; (b) writes `DONE` + exit 0 → asserts
   `state==="done"` and the loop stopped.
   **Commit:** `feat: supervisor loop — resume, usage-limit sleep, DONE detection`.

## Phase 2 — Event parsing (stream-json → rendered events)

4. **Line framing.** Add a `streamParse` helper using `readline.createInterface({ input, crlfDelay:
   Infinity })`; `JSON.parse` each line in try/catch; on failure emit a `{ kind: "raw", line }` event
   (never drop — decisions Q3). Files: `server/autonomous/streamParse.ts`,
   `scripts/streamparse-test.ts`.
   **Verify:** `npx tsx scripts/streamparse-test.ts` → `ALL PASS` — feeds events split across chunk
   boundaries and one non-JSON line; asserts every JSON event parsed once and the bad line surfaced
   as a `raw` event.
   **Commit:** `feat: robust stream-json line framing with raw-event fallback`.

5. **Event → human line renderer.** Map `stream-json` events to `{ icon, summary }` per R3
   (📖 read, 💭 step, 🔧 edit, 🖥️ bash, ✅ ok, 📝 commit) plus the turn divider
   (`─── Turn N complete · Xm Ys · $C · resuming in 10s ───`). Files:
   `server/autonomous/renderEvent.ts`, `scripts/renderevent-test.ts`.
   **Verify:** `npx tsx scripts/renderevent-test.ts` → `ALL PASS` — a fixture of recorded events
   yields the expected icon+summary for each of the six kinds and a correctly formatted divider.
   **Commit:** `feat: render stream-json events as human-readable log lines (R3)`.

6. **Derive the status strip.** Wire `streamParse` + `renderEvent` into the manager and derive the
   R2 status object: `currentStep` (from "Step N/…"), `lastCommit` (short SHA + subject, reconciled
   with `git log -1 --format=%h%x00%s` at turn boundary — decisions Q2), `costUsd` (summed from
   `result` events), `turnElapsed`. Files: `server/autonomous/manager.ts`,
   `server/autonomous/status.ts`.
   **Verify:** `npx tsx scripts/manager-events-test.ts` → `ALL PASS` — feed a recorded stream-json
   fixture through the manager; assert `status.currentStep`, `status.lastCommit`, `status.costUsd`
   are populated as expected.
   **Commit:** `feat: derive R2 status strip (step, last commit, cost) from event stream`.

## Phase 3 — Routes, WebSocket, and tab UI

7. **REST routes.** `registerAutonomousRoutes(app)`: `POST /api/autonomous` (create a tab record +
   start supervisor), `GET /api/autonomous` (list), `GET /api/autonomous/:id` (one, incl. status).
   Error envelope enforced. Files: `server/autonomous/routes.ts`, `server/index.ts` (register).
   **Verify:** `node scripts/autonomous-api-test.mjs` → `ALL PASS` — create returns `{id,state}`,
   list includes it, a missing-required-field body returns `400 { error }`.
   **Commit:** `feat: REST routes for autonomous tabs (create/list/get)`.

8. **WebSocket stream.** Add `/ws/autonomous?tab=<id>` to the existing upgrade handler: on attach,
   send `ready`, replay the event ring buffer, then stream live events + `status` messages; enforce
   the same loopback/origin guard as `/ws`. Files: `server/index.ts`, `server/autonomous/manager.ts`.
   **Verify:** `node scripts/autonomous-ws-test.mjs` → `ALL PASS` — connect after some events exist;
   assert `ready` then replayed events then a live event arrive in order.
   **Commit:** `feat: per-tab WebSocket for autonomous event + status streaming`.

9. **Autonomous tab component.** React component: R2 status strip (state badge, task+UUID
   copy-on-click, step, elapsed, last commit, cost) over the R3 scrolling event log, with the
   "Show raw log" toggle. Register `component: "autonomous"` in the App factory. Files:
   `web/src/AutonomousTab.tsx`, `web/src/App.tsx`.
   **Verify:** `npm run build` exits 0 and `web/dist/index.html` exists (tsc + vite compile the
   component and its wiring).
   **Commit:** `feat: Autonomous tab UI — status strip + live event log (R2, R3)`.

10. **Side pane: live state files.** R4 right-hand pane: `PROGRESS.md` live (markdown-rendered,
    refreshed on the manager's file-change hint + turn boundary), `PLAN.md` read-only with the
    current step highlighted, and a prominent banner when a `## Blockers` section is present. Add
    `GET /api/autonomous/:id/files` returning both file contents + a `blockersPresent` flag. Files:
    `web/src/AutonomousSidePane.tsx`, `server/autonomous/routes.ts`, `web/src/AutonomousTab.tsx`.
    **Verify:** `node scripts/autonomous-files-test.mjs` → `ALL PASS` — endpoint returns both files'
    contents and `blockersPresent:true` when PROGRESS.md contains a `## Blockers` section; then
    `npm run build` exits 0.
    **Commit:** `feat: side pane — live PROGRESS.md/PLAN.md with Blockers banner (R4)`.

## Phase 4 — State persistence

11. **Persist tab records.** Read/write `autonomous.json` (R9 fields) via atomic tmp+rename; the
    manager loads records on construction and writes on every state change. Files:
    `server/autonomous/store.ts`, `server/autonomous/manager.ts`.
    **Verify:** `node scripts/autonomous-persist-test.mjs` → `ALL PASS` — create a tab, read
    `autonomous.json`, assert all R9 fields present with the stored UUID and launch tag.
    **Commit:** `feat: persist autonomous tab records to autonomous.json (R9)`.

12. **Restart survival + relaunch.** On startup, list persisted tabs whose supervisor isn't live as
    `relaunchable`; `POST /api/autonomous/:id/relaunch` restarts the loop with the **stored** UUID
    (`--resume`). Files: `server/autonomous/manager.ts`, `server/autonomous/routes.ts`.
    **Verify:** `node scripts/autonomous-relaunch-test.mjs` → `ALL PASS` — with a persisted-but-dead
    tab, relaunch returns `state:"running"` and the invocation uses the same UUID (assert via the
    stub capturing its args).
    **Commit:** `feat: relaunch a persisted autonomous run with its pinned UUID (R9)`.

## Phase 5 — Pre-flight checks

13. **Core pre-flight checks.** R6 checks 1–4, 6, 7: dir exists & is a git repo; working tree clean
    (`git status --porcelain` empty); `PLAN.md` exists; `PROGRESS.md` exists (else `seedable:true`);
    `~/.claude/CLAUDE.md` contains a heading matching `/^##\s+Autonomous run discipline/m`
    (heading-match, not body-match — see Blockers); `claude --version` succeeds. Return each as
    `{ id, level: "ok"|"warn"|"fail", detail }`. Files: `server/autonomous/preflight.ts`,
    `server/autonomous/routes.ts`.
    **Verify:** `node scripts/preflight-test.mjs` → `ALL PASS` — a clean temp repo with PLAN+PROGRESS
    yields all `ok`; a dirty tree yields `fail` on check 2; a repo with no discipline heading yields
    `warn` + `offerAppend:true`.
    **Commit:** `feat: pre-flight core checks with structured results (R6.1-4,6,7)`.

14. **PLAN.md path scan.** R6 check 5: parse `PLAN.md` for filesystem paths; flag any starting with
    `..`, any absolute path outside the repo root, any unresolved `$ENV`/`%ENV%`; resolve each
    against the configured `--add-dir` list and mark `reachable`. Return the R6 table rows. Files:
    `server/autonomous/pathScan.ts`, `scripts/pathscan-test.ts`.
    **Verify:** `npx tsx scripts/pathscan-test.ts` → `ALL PASS` — a sibling-repo absolute path is
    flagged `reachable:false`; adding its parent to `--add-dir` flips it to `true`; an unresolved
    env var is flagged.
    **Commit:** `feat: PLAN.md path scan — flag out-of-sandbox paths (R6.5, fixes B3/B4)`.

15. **Launch sequence.** R7, in order, gated on zero `fail` results: create rollback tag
    `multiclaude-launch-<task>-<unix>`; create `.multiclaude/<task>/`; idempotently add
    `/.multiclaude/` to `.gitignore`; write the UUID to `.multiclaude/<task>/session`; then
    `manager.start()`. If PROGRESS.md was missing and the user opted in, seed + commit it first so
    the tree is clean at tag time. Files: `server/autonomous/launch.ts`, `server/autonomous/routes.ts`.
    **Verify:** `node scripts/launch-test.mjs` → `ALL PASS` — after launch in a temp repo: the tag
    exists (`git tag -l` matches), `.multiclaude/<task>/session` contains a UUID, `.gitignore`
    contains `/.multiclaude/` exactly once, and `git status --porcelain` is empty.
    **Commit:** `feat: launch sequence — rollback tag, state dir, gitignore, UUID (R7)`.

## Phase 6 — Controls

16. **Control endpoints + buttons.** R5: `POST /api/autonomous/:id/{pause,resume,kill,rollback}`.
    Pause = stop loop + `taskkill /T /F` current turn (state `paused`). Resume = restart with
    `--resume`. Kill = `taskkill` + mark `error`/inconsistent, warn. Rollback = two-step confirm
    showing the exact `git reset --hard <tag>` command, then reset + remove `.multiclaude/<task>/`.
    Wire the four buttons into the tab. Files: `server/autonomous/routes.ts`,
    `server/autonomous/manager.ts`, `web/src/AutonomousTab.tsx`.
    **Verify:** `node scripts/controls-test.mjs` → `ALL PASS` — pause → `paused`; resume →
    `running`; after committing a dummy change then rollback, `git rev-parse HEAD` equals the tag's
    SHA and `.multiclaude/<task>/` is gone. Then `npm run build` exits 0.
    **Commit:** `feat: pause/resume/kill/rollback controls (R5, fixes B6)`.

## Phase 7 — Onboarding & templates

17. **New-tab Autonomous option + first-run onboarding.** Add an "Autonomous" choice to the new-tab
    flow with the R1 fields (project dir, task name, PLAN.md detect, additional dirs, model, budget)
    and an embedded pre-flight panel that gates Launch (disabled on any `fail`; each `warn` needs an
    "I accept this risk" checkbox). Add the one-time R11 onboarding modal (dismissable, re-openable
    from a help icon). Files: `web/src/AutonomousNewDialog.tsx`, `web/src/AutonomousOnboarding.tsx`,
    `web/src/NewSessionDialog.tsx`.
    **Verify:** `npm run build` exits 0 and `web/dist/index.html` exists.
    **Commit:** `feat: Autonomous new-tab dialog with gated pre-flight + onboarding (R1, R11)`.

18. **Project scaffold / templates.** R12: `POST /api/autonomous/scaffold` writes `PLAN.md` from the
    `plan-template.md` shape and `PROGRESS.md` with the standard header into a target dir (refusing
    to overwrite existing files). Files: `server/autonomous/scaffold.ts`, `server/autonomous/routes.ts`.
    **Verify:** `node scripts/scaffold-test.mjs` → `ALL PASS` — scaffold into an empty temp dir
    creates `PLAN.md` (contains the "Invariants (apply to every step)" line) and `PROGRESS.md`
    (contains `## Blockers`); a second scaffold over existing files returns `409 { error }`.
    **Commit:** `feat: scaffold PLAN.md/PROGRESS.md from templates (R12)`.

19. **Green capstone.** Add `docs/autonomous-tab-status.md` summarising what v1 delivers and mapping
    each requirement to its verify command. **[LIVE for the acceptance line]**
    **Verify:** the full local gate passes — `npm run build` **&&** every deterministic test above
    (`npx tsx scripts/streamparse-test.ts && npx tsx scripts/renderevent-test.ts && npx tsx
    scripts/pathscan-test.ts && node scripts/autonomous-api-test.mjs && node
    scripts/preflight-test.mjs && node scripts/launch-test.mjs && node scripts/controls-test.mjs`)
    — all exit 0.
    **Commit:** `docs: autonomous tab v1 complete`.
    **Then:** create the empty `DONE` file at repo root and stop.

---

## STOP HERE — v1 boundary

Do **not** proceed past Step 19 autonomously. The next work — reproducing the full 2026-07-13
Foundry Clarion Phase 0-1 run end-to-end (acceptance #7) — requires a **live, authenticated
`claude` CLI running against a real external project and spending real tokens**, plus a human to
judge that the reproduced run matches the original. That is a decision and a cost only Steven can
authorise. When all 19 steps are done, create the empty `DONE` file and stop.

Anything the plan revealed as missing goes in `autonomous-tab-decisions.md` for approval — never
straight into the code (spec rule: no feature creep).

---

## Blockers

Sharp questions I would rather have answered than guess. Each names the exact thing at issue.

1. **`--max-turns` is gone (hard blocker for R1 + R8).** The installed `claude` CLI (v2.1.207) has
   no `--max-turns` flag (confirmed via `claude --help`). Spec R1's "Max turns per invocation —
   default 60" field and R8's `--max-turns <configured>` line cannot be implemented as written. My
   recommendation (decisions cross-cutting #1): **remove the field**, rely on the R10 prompt +
   discipline block to keep each turn to one step, and keep `--max-budget-usd` as the only hard
   per-invocation cap. **Confirm I should drop the field**, or tell me the substitute you want (e.g.
   a stop-hook that halts after one commit).

2. **R5's SIGTERM/SIGKILL wording doesn't exist on Windows.** `child.kill('SIGTERM')` is a hard kill
   on Windows and the codebase deliberately uses `taskkill /T /F` instead. So Pause and Kill are
   both hard tree-kills that differ only in intent/messaging (decisions cross-cutting #2). This is
   safe because an unfinished turn hasn't committed. **Confirm** Pause = "stop the loop + taskkill
   current, resumable" and Kill = "taskkill + mark inconsistent" is the behaviour you want, versus
   expecting a genuine graceful-drain (which the platform can't give).

3. **Which `--allowedTools` scope for Bash?** R8 accepts either blanket `Bash` or scoped
   (`Bash(git *)`, `Bash(npm *)`, `Bash(npx *)`). The tighter scope is safer but will silently deny
   any build/test command a user's PLAN.md invokes outside git/npm/npx (e.g. `pytest`, `cargo`,
   `dotnet`), which then looks like a hang. Step 1 pins whatever *works*, but the **policy** is
   yours: do you want a fixed allowlist, or should the new-tab dialog expose the Bash allow-rules so
   a user can widen them per project? I lean "start with `git`/`npm`/`npx`/`node` scoped, and make it
   editable in the dialog" — but that edges toward the field-count you might not want.

4. **The discipline block already differs between two sources.** Your live `~/.claude/CLAUDE.md`
   carries a 6-point "Autonomous run discipline" section, while
   `docs/specs/claude-md-autonomous-discipline.md` is the 7-point canonical version (adds "Never
   scaffold half a step"). Pre-flight R6.6 therefore must match on the **heading**, not the body,
   or it will nag correctly-configured machines. Step 13 does heading-match. **Confirm** you want
   pre-flight to only ensure the *section exists* (not that it's byte-identical to the companion
   doc), and whether the "offer to append" action should append the 7-point canonical version even
   when a shorter one is already present (I'd say: if the heading exists, leave it alone).

5. **Does a live, authenticated `claude` exist in the environment where this plan will run?** Steps
   1 and 19 are `[LIVE]` — they invoke the real CLI and cost tokens. If this plan is itself run
   unattended by the Autonomous tab, those steps will either need `claude` authenticated in that
   environment or they must stop with a Blockers entry (which is the correct discipline). **Tell me**
   whether to keep Step 1 as a hard gate at position 1, or move both live steps to the very end
   behind an explicit "run the live gate now?" confirmation so the deterministic 90% can complete
   unattended first.
