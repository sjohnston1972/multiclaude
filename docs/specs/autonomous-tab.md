# Feature Spec: Autonomous Tab

**Status:** Draft for build-agent planning
**Author:** Steven Johnston
**Date:** 2026-07-13
**Repo:** multiclaude
**Save to:** `docs/specs/autonomous-tab.md`

---

## 1. Context

multiclaude is a browser-based manager for parallel Claude Code sessions. This feature adds a
new tab mode — **Autonomous** — that wraps Claude Code in a resumable, observable, limit-aware
loop suitable for long-running or overnight work.

It replaces an ad-hoc PowerShell wrapper (`ccrun`) that proved the pattern works but had poor
observability. That wrapper was live-tested on 2026-07-13 against the Foundry Clarion Phase 0-1
build. The test is the primary source of requirements in §4.

## 2. User story

> As a Claude Code user with a large or multi-day task, I want to hand it to multiclaude, walk
> away, and come back to either a completed task or a clear explanation of why it stopped —
> without having to know anything about session IDs, prompt engineering, or shell scripting.

## 3. The pattern being encoded

Four mechanisms, all validated in the 2026-07-13 test:

**3.1 — State on disk is truth.**
A `PLAN.md` at the repo root lists numbered steps, each a single commit-able chunk with an
explicit verification command. A `PROGRESS.md` is the append-only handoff log between turns.
A `DONE` file signals task complete (or blocked-and-stopped). The conversation context is
disposable; the files are not.

**3.2 — Pinned session ID.**
A UUID is generated on first launch and stored on disk. Every subsequent invocation uses
`--resume <uuid>` so the conversation survives usage-limit resets and process restarts.
`--continue` is explicitly NOT used — it is unreliable in non-interactive mode and can silently
create a new session.

**3.3 — Discipline in the system prompt.**
A block appended to `~/.claude/CLAUDE.md` (user-global) tells Claude how to behave when it sees
both `PLAN.md` and `PROGRESS.md`. See the companion file `claude-md-autonomous-discipline.md`.

**3.4 — Wrapped supervisor loop.**
A supervisor process invokes Claude Code headless, parses its event stream, detects
usage-limit errors, and re-invokes after the reset window.

## 4. What went wrong in the v1 test — these ARE the requirements

Every requirement in §5 traces back to one of these. Recorded from the 2026-07-13 live run.

| # | What broke | Consequence | Fixed by |
|---|---|---|---|
| B1 | `--output-format json` emits one blob at end-of-turn | Operator saw silence for 2-8 minutes; a working system felt broken | R3 |
| B2 | `--permission-mode acceptEdits` doesn't cover bash | Claude wrote a correct blocker analysis but was denied `git commit` | R8 |
| B3 | No pre-flight validation of PLAN.md | A path to a sibling repo (outside the sandbox) was discovered at runtime, not launch time | R6 |
| B4 | Sibling-repo access never declared | Claude Code sandboxes to the working directory unless `--add-dir` grants more | R1, R6 |
| B5 | No visible per-tab state | Operator needed three PowerShell windows running `git log`, `git status`, `Get-Content PROGRESS.md` | R2, R4 |
| B6 | No one-click rollback | Operator had to manually `git tag` before launch and `git reset --hard` on abort | R5, R7 |

**What did NOT break, and must be preserved:** the discipline itself. When Claude hit a genuine
environmental blocker it refused to write a half-scaffolded `package.json`, wrote a precise
three-option Blockers entry, created `DONE`, and stopped. That behaviour is the whole point of
the feature. Do not weaken it.

## 5. Requirements

### R1 — Tab mode selection

A new tab type **Autonomous** in the new-tab dialog. Fields:

- **Project directory** — required, folder picker
- **Task name** — required, kebab-case, becomes the state-dir name
- **PLAN.md** — auto-detected at repo root; button to open in editor; hard warning if missing
- **Additional directories** — optional list; each becomes an `--add-dir` flag (fixes B4)
- **Model** — default `sonnet`, `opus` available
- **Budget cap USD** — optional, maps to `--max-budget-usd`. This is the only hard per-invocation
  cap. There is **no** turn cap: `--max-turns` was removed from the `claude` CLI (verified absent in
  v2.1.207, top-level and print-mode help), so the per-turn "do exactly one step then stop" bound
  comes from the R10 prompt and the discipline block, not a flag.
- **Extra Bash allow-rules** — optional free-text; appended to the default
  `Bash(git *) Bash(npm *) Bash(npx *) Bash(node *)` allowlist so a plan that runs `pytest`,
  `cargo`, `dotnet`, etc. can be widened per project (see R8)

Below the fields, a pre-flight panel (R6) that must go green before Launch enables.

### R2 — Status strip (top of tab, always visible)

One line, real-time:

- Task name + session UUID (copy-on-click)
- State badge: `preflight` | `running` | `sleeping (limit until HH:MM)` | `blocked` | `DONE` | `error`
- Current step: `Step 3/10: Health endpoint`
- Elapsed time in current turn
- Total elapsed since launch
- Last commit: short SHA + message
- Accumulated cost USD

This strip alone should answer "is this thing OK" at a glance.

### R3 — Human-readable event stream (main body)

Replace v1's raw JSON with parsed events from
`--output-format stream-json --include-partial-messages --verbose`.

Render each event as one line, icon + short human summary:

```
📖  Reading PLAN.md
📖  Reading PROGRESS.md
💭  Working on Step 1: Scaffold & install
🔧  Editing package.json
🔧  Editing wrangler.jsonc
🖥️  Running: npm install
✅  npm install exited 0
🖥️  Running: npx vitest run test/migration.test.ts
✅  Tests passed
📝  Committing: feat: 0001_init — cc_org_directory, cc_members, cc_audit_log
✅  Committed abc1234
📝  Appended Step 1 to PROGRESS.md
```

Between turns, a clear divider:

```
─── Turn 3 complete · 4m 12s · $0.42 · resuming in 10s ───
```

Provide a **Show raw log** toggle exposing the underlying JSON events for debugging.

### R4 — Side pane: live state files

Collapsible right-hand pane, two sub-tabs:

- **PROGRESS.md** — live, auto-refresh on file change, markdown-rendered
- **PLAN.md** — read-only, current step highlighted

If a `## Blockers` section appears in PROGRESS.md, surface it prominently (banner or accent
colour) — this is the single most important signal in the whole feature.

### R5 — Control buttons (top-right of tab)

- **Pause** — SIGTERM the current invocation cleanly; session preserved. Confirm dialog.
- **Resume** — restart the loop using the stored session UUID.
- **Rollback** — `git reset --hard <launch-tag>` and remove the state dir. Two-step confirm,
  showing the exact command that will run.
- **Kill** — SIGKILL. Session preserved but state may be inconsistent; warn accordingly.

### R6 — Pre-flight validation (fixes B3, B4)

Runs before Launch is enabled. Displays each check with ✅ / ⚠️ / ❌:

1. Project directory exists and is a git repo
2. Working tree is clean (no uncommitted changes)
3. `PLAN.md` exists at repo root
4. `PROGRESS.md` exists at repo root — if missing, offer to seed it (single header line) and commit
5. **Path scan:** parse PLAN.md for filesystem paths. Flag any path starting with `..`, any
   absolute path outside the repo, and any unresolved environment variable. Display a table:
   `path found` | `resolves to` | `reachable given current --add-dir list?`
6. `~/.claude/CLAUDE.md` contains the "Autonomous run discipline" section — if missing, offer
   to append it
7. `claude` CLI is on PATH and reports a version

Launch disabled while any ❌ remains. Any ⚠️ requires an explicit "I accept this risk" checkbox.

### R7 — Launch sequence

On Launch, in order:

1. Create rollback tag: `git tag multiclaude-launch-<task-name>-<unix-timestamp>`
2. Create state directory `.multiclaude/<task-name>/`; ensure `.multiclaude/` is in `.gitignore`
3. Generate session UUID, write to `.multiclaude/<task-name>/session`
4. Start the supervisor process
5. First invocation uses `--session-id <uuid>`; every subsequent one uses `--resume <uuid>`

### R8 — Supervisor loop behaviour (fixes B1, B2)

```
loop:
  if DONE exists → state = DONE, exit

  invoke claude with:
    -p "<autonomous run prompt from R10>"
    --resume <session-id>                    # --session-id on the very first call only
    --output-format stream-json
    --include-partial-messages
    --verbose
    --allowedTools "Read Edit Write Glob Grep Bash(git *) Bash(npm *) Bash(npx *) Bash(node *) <plus any extra allow-rules from R1>"
    --permission-mode acceptEdits
    --add-dir <each configured extra dir>
    --model <configured>
    [--max-budget-usd <configured>]

  parse stream-json events → render to tab (R3)

  on exit 0:
    sleep 10s
    loop

  on exit != 0:
    if output matches /hit your (session|weekly) limit/:
      parse the reset time from the message
      state = sleeping
      sleep until reset + 60s jitter
      loop
    else:
      state = error
      display last 20 events
      stop
```

**On B2 specifically:** the allowed-tools list MUST cover git so `git add` / `git commit` succeed.
Default to the scoped set `Bash(git *) Bash(npm *) Bash(npx *) Bash(node *)` (safer than blanket
`Bash`), widened per project via the R1 "Extra Bash allow-rules" field. A denied Bash command does
**not** hang the run: in the 2026-07-13 test the result JSON's `permission_denials` array was
populated with every denied call and Claude reported the denial in its summary — denials surface,
they don't stall. Verify the git path by observing an actual commit land in the first turn of an
integration test.

### R9 — Persistence

Each autonomous tab is a first-class persisted object (use multiclaude's existing tab store):

- id, task name, project dir, additional dirs
- session UUID
- launch tag name
- current state, current step number
- start time, last-turn time
- accumulated cost USD
- last error, if any

On multiclaude restart, autonomous tabs re-render from persisted state. If the supervisor
process died with the server, offer a one-click relaunch — the pinned UUID means the
conversation continues, not restarts.

### R10 — The autonomous run prompt (baked in, not user-authored)

Sent to Claude on every turn:

```
Read PLAN.md and PROGRESS.md as your first action. Identify the next incomplete
step from PLAN.md. Do exactly that one step. Commit each change with a clear
message referring to the step number, then push it with `git push` so the work
never exists only on this machine — stay on the current branch, don't create one.
If the push fails (no remote, no upstream, auth, rejected), that is NOT a blocker:
note it in PROGRESS.md and carry on. Append a timestamped entry to PROGRESS.md
when the step is verified done. If every step in PLAN.md is complete, create an
empty file called DONE and stop. If the plan is ambiguous or a step cannot be
completed, write a precise Blockers entry in PROGRESS.md, create DONE, and stop.
Always re-read PLAN.md and PROGRESS.md at the start of every turn — never trust
prior context.
```

### R11 — First-run onboarding

One-time walkthrough when a user first selects Autonomous:

1. What the pattern is (2-3 sentences)
2. What a good PLAN.md looks like (link to the template)
3. What multiclaude does automatically (state files, rollback tag, discipline block)
4. What multiclaude does **not** do — write PLAN.md. That is the user's job and the highest-leverage part.

Dismissable; re-openable from a help icon.

### R12 — Templates

Ship a **New autonomous project** action that scaffolds:

- `PLAN.md` from the standard template (see companion file `plan-template.md`)
- `PROGRESS.md` with the standard header
- Suggested `--add-dir` entries if the user picks a "monorepo" or "sibling-repo" project shape

## 6. Acceptance criteria

The feature is done when a user can:

1. Open multiclaude → New Tab → Autonomous, pick a git repo with a PLAN.md, and see a green
   pre-flight panel within 5 seconds.
2. Click Launch and immediately see human-readable events flowing, without opening any other window.
3. Close the browser, return an hour later, and see the tab still running with correct state.
4. Watch the tab pause itself when a usage limit hits, correctly parse the reset time, and resume after.
5. See a `blocked` state with the PROGRESS.md Blockers section rendered prominently when Claude
   stops on an ambiguity.
6. Click Rollback and have the working tree returned to the launch tag with no residual files.
7. Reproduce the 2026-07-13 Foundry Clarion Phase 0-1 run (tarball blocker resolved) end to end
   with zero PowerShell commands.

## 7. Out of scope for v1

Deliberately excluded. Do not add these back without approval.

- Multi-repo orchestration inside a single tab
- Parallel autonomous tabs coordinating through shared state
- Automatic PLAN.md generation from a natural-language prompt
- Slack / email / push notifications on state change
- Mid-turn budget enforcement (per-invocation `--max-budget-usd` only)
- Non-git projects

## 8. Open questions for the build agent

Answer these in `autonomous-tab-decisions.md` before writing code.

1. **Where does the supervisor process live?** In-browser via WebSocket to the multiclaude
   backend? A separate Node process spawned by the server? A container per tab? Trade-offs:
   process isolation vs. complexity vs. surviving a server restart.
2. **How is git state polled cheaply?** File watcher on `.git/index`? Fixed 2-second poll?
   The status strip needs last-commit info without hammering disk.
3. **Is stream-json parsing robust to partial reads?** Events arrive as newline-delimited JSON;
   a buffered read can split a line. Confirm the buffer-until-newline-then-parse approach and
   handle the edge case where a single event exceeds the buffer.
4. **State directory naming.** v1 used `.ccrun/`. Proposal: `.multiclaude/<task-name>/`. Confirm
   or counter-propose, considering cross-platform path handling and gitignore ergonomics.
