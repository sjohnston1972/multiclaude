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
  `--verbose`, `--permission-mode acceptEdits`, `--add-dir <each>`, `--model <configured>`, optional
  `--max-budget-usd`, and `--allowedTools` defaulting to the scoped set
  `Read Edit Write Glob Grep Bash(git *) Bash(npm *) Bash(npx *) Bash(node *)`, widened by the R1
  "Extra Bash allow-rules" free-text field. **No `--max-turns`** — it does not exist in the installed
  CLI (v2.1.207, top-level and print-mode help); the one-step-per-turn bound comes from the R10
  prompt + discipline block. A denied Bash command surfaces in the result JSON's `permission_denials`
  array (it does not hang the run), so the tight default scope is safe.
- **Autonomous range:** Step 1 and Step 19 are `[LIVE]` — Steven runs them interactively (Step 1 is a
  fallback-ladder spike needing human judgment; Step 19 spends real tokens). **Steps 2–18 are the
  unattended-autonomous range** — all deterministic (fake-claude stub), safe to run one-per-turn
  without a human present.
- **Branch policy:** all work on `feat/autonomous-tab` (this feature's branch). Conventional commits,
  one commit per step. Never commit with a failing `npm run build`.

---

## Phase 1 — Backend supervisor (process lifecycle)

1. **Pin the claude invocation (spike). [LIVE — Steven runs interactively]** Prove B2/R8 before building anything: in a throwaway
   temp git repo seeded with a one-step `PLAN.md` ("create `hello.txt` containing `hi`, commit"),
   a `PROGRESS.md`, and a temp `CLAUDE.md` carrying the discipline block, run the pinned invocation
   once and assert a commit landed. Files: `scripts/claude-invoke-test.mjs` (+ `scripts/_stub/`
   fixtures if needed).
   **Verify:** `node scripts/claude-invoke-test.mjs` → `ALL PASS` — a rung lands ≥1 commit that
   *tracks* `hello.txt` containing `hi` (asserted via `git ls-files`, since the discipline may also
   commit PROGRESS.md/DONE). If a rung fails it escalates (`Bash(git *)` scope → blanket `Bash` →
   `--dangerously-skip-permissions`) and prints the winning rung.
   **Commit:** `test: pin claude headless invocation that lands a commit (fixes B2)`.
   **DONE (2026-07-13):** PASS on **Rung A** (`acceptEdits` + scoped `Bash(git *) Bash(npm *)
   Bash(npx *) Bash(node *)`), $0.23, no escalation. A denied `xxd` surfaced in `permission_denials`
   without hanging (confirms B3). Use Rung A as the pinned permission strategy from Step 2 on.

2. **`AutonomousManager` skeleton + fake-claude stub.** Add a manager that spawns a configurable
   command (defaults to `claude`, overridable so tests point at a stub), tracks `state`
   (`preflight|running|sleeping|blocked|done|error`), holds an in-memory event ring buffer +
   listener set (mirroring `SessionManager`), and exposes `start()` / `stop()`. Spawn the child with
   **stdin ignored** (`stdio: ["ignore", "pipe", "pipe"]`) — the Step 1 spike showed `claude` stalls
   ~3s each turn waiting on stdin otherwise, which would read as B1-style silence. Pin the Rung A
   permission strategy from Step 1. Add `scripts/_stub/fake-claude.mjs` emitting scripted
   `stream-json` then exiting 0. Files: `server/autonomous/manager.ts`, `server/autonomous/types.ts`,
   `scripts/_stub/fake-claude.mjs`.
   **Verify:** `npx tsx scripts/manager-spawn-test.ts` → `ALL PASS` — start against the stub,
   observe `state` go `running → done` and ≥1 event buffered.
   **Commit:** `feat: AutonomousManager skeleton spawning claude via child_process`.

3. **Supervisor loop + state-file integrity guard.** Implement the R8 loop over the manager: check
   for `DONE` (→ `done`, exit); exit 0 → sleep 10s → re-invoke with `--resume`; exit ≠ 0 → if
   stderr/stream matches `/hit your (session|weekly) limit/` parse reset time → `sleeping` until
   reset + jitter, else `error` + retain last 20 events. First call uses `--session-id`, subsequent
   `--resume`. **Integrity guard (before every re-invocation):** if `PLAN.md` is missing/unreadable
   or `PROGRESS.md` is missing/unreadable, do **not** invoke into the void — set `state = error`,
   record the exact file + reason, stop the loop. This is the discipline applied to the supervisor
   itself: never keep marching when the ground truth is gone. Files: `server/autonomous/manager.ts`,
   `server/autonomous/loop.ts`.
   **Verify:** `npx tsx scripts/loop-test.ts` → `ALL PASS` — stub emits (a) a limit message + exit 1
   → asserts `state==="sleeping"` and a computed wake time; (b) writes `DONE` + exit 0 → asserts
   `state==="done"` and the loop stopped; (c) delete `PLAN.md` between turns → asserts `state==="error"`,
   a reason naming `PLAN.md`, and **no** further invocation of the stub.
   **Commit:** `feat: supervisor loop — resume, usage-limit sleep, DONE + state-file integrity guard`.

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
   **Human check (build ≠ working):** open an autonomous tab in the browser and confirm with your
   eyes that the status strip shows a live state badge, a non-blank current step, and a ticking
   elapsed time, and that event lines actually scroll in as the stub/real run emits them — a strip
   that renders blank would still pass the build gate.
   **Commit:** `feat: Autonomous tab UI — status strip + live event log (R2, R3)`.

10. **Side pane: live state files.** R4 right-hand pane: `PROGRESS.md` live (markdown-rendered,
    refreshed on the manager's file-change hint + turn boundary), `PLAN.md` read-only with the
    current step highlighted, and a prominent banner when a `## Blockers` section is present. Add
    `GET /api/autonomous/:id/files` returning both file contents + a `blockersPresent` flag. Files:
    `web/src/AutonomousSidePane.tsx`, `server/autonomous/routes.ts`, `web/src/AutonomousTab.tsx`.
    **Verify:** `node scripts/autonomous-files-test.mjs` → `ALL PASS` — endpoint returns both files'
    contents and `blockersPresent:true` when PROGRESS.md contains a `## Blockers` section; then
    `npm run build` exits 0.
    **Human check (build ≠ working):** with a run whose PROGRESS.md has a `## Blockers` section open,
    confirm with your eyes that the Blockers banner is visibly prominent (accent colour, not buried),
    that PROGRESS.md re-renders when the file changes on disk, and that PLAN.md highlights the current
    step — the endpoint test proves the data, not that the most important signal in the feature is
    actually eye-catching.
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
    flow with the R1 fields (project dir, task name, PLAN.md detect, additional dirs, model, budget
    cap, extra Bash allow-rules — **no** "max turns" field) and an embedded pre-flight panel that
    gates Launch (disabled on any `fail`; each `warn` needs an
    "I accept this risk" checkbox). Add the one-time R11 onboarding modal (dismissable, re-openable
    from a help icon). Files: `web/src/AutonomousNewDialog.tsx`, `web/src/AutonomousOnboarding.tsx`,
    `web/src/NewSessionDialog.tsx`.
    **Verify:** `npm run build` exits 0 and `web/dist/index.html` exists.
    **Human check (build ≠ working):** open the new-tab Autonomous flow and confirm with your eyes
    that the pre-flight panel actually renders ✅/⚠️/❌ rows, that Launch is genuinely disabled while a
    ❌ is present and only enables once each ⚠️ has its "I accept this risk" box ticked, and that the
    first-run onboarding modal appears then stays dismissed. Gating logic that compiles but doesn't
    disable the button would still pass the build.
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

## Resolved decisions (2026-07-13, Steven)

All five plan-time blockers were answered before build. Recorded here so the plan is self-consistent
and the next reader inherits the decision, not the open question.

1. **`--max-turns` — dropped.** Confirmed absent from the installed CLI (v2.1.207) in both top-level
   and print-mode help; `--max-budget-usd` confirmed present. The R1 "Max turns" field and the R8
   `--max-turns` line are removed from `autonomous-tab.md` (done in this same change). `--max-budget-usd`
   is the only hard per-invocation cap; the one-step-per-turn bound comes from the R10 prompt +
   discipline block.

2. **Windows Pause/Kill — confirmed as proposed.** Pause = stop the loop + `taskkill /T /F` the
   current turn (resumable via `--resume`, which re-reads the state files and redoes the uncommitted
   step). Kill = same tree-kill + mark state inconsistent + warn. No graceful-drain is possible on
   Windows and none is needed, because an unfinished turn hasn't committed.

3. **Bash scope — scoped default + one editable field.** Correction to my earlier assumption: a
   denied Bash command does **not** hang — it lands in the result JSON's `permission_denials` array
   and Claude reports it in its summary (observed in the 2026-07-13 run). So the tight scope is the
   safe default: `Bash(git *) Bash(npm *) Bash(npx *) Bash(node *)`, plus a single free-text
   "Extra Bash allow-rules" field in the new-tab dialog (Step 17) to widen it for `pytest`/`cargo`/
   `dotnet`/etc. One field, not more.

4. **Discipline check — heading-match only.** Pre-flight R6.6 (Step 13) ensures a heading matching
   `/^##\s+Autonomous run discipline/m` exists in `~/.claude/CLAUDE.md` and does nothing else: if the
   heading is present it is left untouched (a shorter live version is never overwritten with the
   7-point canonical one). The "offer to append" path fires only when the heading is entirely absent.

5. **[LIVE] steps — Step 1 stays at position 1; Steven runs it.** Nothing is built on an unproven
   invocation, so the spike remains first, run interactively by Steven (its fallback ladder needs
   human judgment). Step 19's live gate is likewise interactive. **Steps 2–18 are the unattended
   range** (all deterministic via the fake-claude stub) — marked in the invariants above.
