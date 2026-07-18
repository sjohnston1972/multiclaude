# Autonomous Tab — v1 status

**Delivered:** the Autonomous tab described in `docs/specs/autonomous-tab.md`, built via the plan in
`docs/specs/autonomous-tab-plan.md` with decisions in `docs/specs/autonomous-tab-decisions.md`.

An Autonomous tab hands a task to Claude Code in a resumable, observable, limit-aware loop: one
step per turn, a commit per step, stop on DONE or on a Blockers entry. The server owns the run
(sibling of `SessionManager`); the browser is a viewer.

## What v1 delivers

- **Supervisor** (`server/autonomous/`): an in-server `AutonomousManager` spawns `claude` headless
  (piped stdout, stdin ignored), runs the R8 loop (`--session-id` first, `--resume` after; sleep on
  usage limit; stop on DONE), and guards against running when PLAN.md/PROGRESS.md vanish.
- **Event pipeline**: robust `stream-json` framing (`readline`, raw fallback) → human log lines
  (📖/💭/🔧/🖥️/✅/📝) → derived R2 status strip (step, last commit, cost, elapsed).
- **Transport**: REST (`/api/autonomous…`) + a per-tab WebSocket (`/ws/autonomous?tab=`) with
  replay-on-attach, so closing the browser and coming back just works.
- **UI**: status strip + live event log + raw toggle, a side pane with live PROGRESS.md/PLAN.md and
  a prominent Blockers banner, and Pause/Resume/Kill/Rollback controls.
- **Persistence**: first-class tab records in `autonomous.json`; relaunch after a restart reuses the
  pinned UUID.
- **Pre-flight** (R6) gating Launch, including the PLAN.md path scan that catches the exact
  sibling-repo blocker from the 2026-07-13 run.
- **Launch/rollback** (R7/R5): rollback tag + gitignored state dir at launch; one-click
  `git reset --hard <tag> && git clean -fd` + state-dir removal on rollback.
- **Onboarding + scaffold** (R11/R12), and the **discipline-block append** (R6.6): the launch
  dialog offers, on a missing-block ⚠️, an "Append discipline block" button (writes the canonical
  7-point block to `~/.claude/CLAUDE.md`, idempotent, heading-match) and a "Scaffold PLAN.md +
  PROGRESS.md" button on a missing-PLAN ❌ — so a new session invocation can create all of
  PLAN.md, PROGRESS.md, the discipline block, and (via the run) DONE.

## Requirement → verify command

Deterministic suite (no real `claude`, no tokens):

| Area | Verify command |
|---|---|
| Build (all TS compiles) | `npm run build` |
| R8 loop / integrity guard | `npx tsx scripts/loop-test.ts` |
| Manager spawn + buffer | `npx tsx scripts/manager-spawn-test.ts` |
| R3 framing | `npx tsx scripts/streamparse-test.ts` |
| R3 render | `npx tsx scripts/renderevent-test.ts` |
| R2 status strip | `npx tsx scripts/manager-events-test.ts` |
| R6.5 path scan | `npx tsx scripts/pathscan-test.ts` |
| REST create/list/get | `npx tsx scripts/autonomous-api-test.ts` |
| WebSocket replay + live | `npx tsx scripts/autonomous-ws-test.ts` |
| R4 side-pane files | `npx tsx scripts/autonomous-files-test.ts` |
| R9 persistence | `npx tsx scripts/autonomous-persist-test.ts` |
| R9 relaunch | `npx tsx scripts/autonomous-relaunch-test.ts` |
| R6.1-4,6,7 pre-flight | `npx tsx scripts/preflight-test.ts` |
| R6.6 discipline append | `npx tsx scripts/discipline-test.ts` |
| R7 launch sequence | `npx tsx scripts/launch-test.ts` |
| R5 controls | `npx tsx scripts/controls-test.ts` |
| R12 scaffold | `npx tsx scripts/scaffold-test.ts` |
| v2 draft-plan helper | `npx tsx scripts/draft-plan-test.ts` |
| v2 repo tagging / discovery | `npx tsx scripts/autonomous-discovery-test.ts` |

Live (needs an authenticated `claude`, spends a few cents) — the B2 acceptance line:

| Area | Verify command |
|---|---|
| Pinned invocation lands a commit | `node scripts/claude-invoke-test.mjs` |

## v2 additions (post-v1, driven by dogfooding)

Built and deployed after the v1 plan, each as its own committed + verified change:

- **Draft-a-plan helper** — the missing-PLAN ❌ row offers a recommended "Draft a plan with Claude ★"
  that opens a normal terminal tab running primed interactive `claude` (`--append-system-prompt-file`,
  `--dangerously-skip-permissions` so it doesn't pester), file-based hand-off back to pre-flight.
- **Discipline-block append** (R6.6) and **scaffold** offered as actions from the launch dialog, so a
  new session can create PLAN.md / PROGRESS.md / the CLAUDE.md discipline block.
- **Repo tagging** — repos with the state files are badged `ready`/`completed`/`drafting` in the launch
  dialog quick-pick, home-screen tiles, and the folder browser (`server/autonomous/discovery.ts`,
  `GET /api/autonomous/ready`).
- **Completion clarity** — the elapsed clock freezes on a terminal state (server `finishedAt`) and a
  loud state banner (done/blocked/error/paused/sleeping) removes the "did it finish?" ambiguity.
- **Blockers false-positive fix** — `- (none)` / `N/A` / `no blockers yet` placeholders no longer trip
  the Blockers banner or mis-classify a done run as blocked.
- **Path-scan polish** — URL routes (`/api/hello`) are no longer flagged as filesystem paths; the panel
  shows only paths needing attention.
- **Markdown side pane** — PROGRESS.md / PLAN.md render with a dependency-free markdown component.
- **Cache-hit %** in the status strip — share of input tokens served from the prompt cache, from each
  turn's `result.usage`; a live gauge of resume efficiency.
- **Persistent "⚙ Autonomous" top-bar button** — reopens pre-flight pre-filled with the last project.
- **Fresh session per turn** — the loop no longer resumes one growing conversation. Each turn
  mints its own conversation id, so per-turn cost is flat instead of quadratic in run length and
  a post-limit wakeup is no longer the most expensive turn of the run. The run's pinned UUID is
  unchanged; `freshSessionPerTurn: false` restores the old behaviour for comparison. Expect the
  cache-hit % gauge to drop sharply — that is the trade, not a regression. Design:
  `docs/superpowers/specs/2026-07-18-fresh-session-per-turn-design.md`.

Server default is now LAN mode on this machine (persistent env vars), per operator preference.

## Pending human checks (build ≠ working)

Steps 9, 10, and 17 are UI; their build gate proves compilation, not behaviour. Confirm by eye:
the status strip ticks and events stream; the Blockers banner is prominent and PLAN highlights the
current step; the pre-flight panel disables Launch on ❌ and requires accepting each ⚠️.

## Deliberately not in v1 (spec §7)

Multi-repo orchestration in one tab, parallel-tab coordination, automatic PLAN.md generation,
notifications, mid-turn budget enforcement, non-git projects.
