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

Live (needs an authenticated `claude`, spends a few cents) — the B2 acceptance line:

| Area | Verify command |
|---|---|
| Pinned invocation lands a commit | `node scripts/claude-invoke-test.mjs` |

## Pending human checks (build ≠ working)

Steps 9, 10, and 17 are UI; their build gate proves compilation, not behaviour. Confirm by eye:
the status strip ticks and events stream; the Blockers banner is prominent and PLAN highlights the
current step; the pre-flight panel disables Launch on ❌ and requires accepting each ⚠️.

## Deliberately not in v1 (spec §7)

Multi-repo orchestration in one tab, parallel-tab coordination, automatic PLAN.md generation,
notifications, mid-turn budget enforcement, non-git projects.
