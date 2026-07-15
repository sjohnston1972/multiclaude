# multiclaude

Run and manage multiple Claude Code sessions in a single browser window —
tabs, draggable split layouts, each pane a full real PowerShell terminal. The
server holds the terminals; the browser is just a viewer. Close or refresh the
browser and your sessions keep running — reconnecting reattaches and replays
recent output, like plugging back into a console port.

Panes come in two kinds. Most are **terminals** — a real shell you type in,
usually running `claude`. The other is an **[Autonomous run](#autonomous-runs)**:
you hand Claude a written work order and it executes it unattended, one step per
turn, committing as it goes, while you watch it happen (or sleep through it).

**Security note — read this first.** This app gives whoever connects a real
shell on your machine. That is the entire point of it, and it is why the
defaults are what they are:

- It listens on `127.0.0.1` only, and **refuses to start** on a non-loopback
  address unless you explicitly set `MULTICLAUDE_UNSAFE_HOST=1` (which prints a
  loud warning). LAN mode below is that opt-in, deliberately.
- It rejects any REST or WebSocket request whose browser origin isn't the
  address it's answering on, so a random website you visit can't reach in and
  spawn a shell through your browser, and DNS-rebinding attacks are refused.
- There is no telemetry and no outbound call of its own — only what your own
  shells make.

**Never put it behind a tunnel or reverse proxy.** There is no authentication,
because on loopback there's nothing to authenticate. Exposing it to the
internet hands your machine to anyone who finds the port.

This is a personal tool built for one Windows machine, not a product. It's
public so people can read it, learn from it, or fork it — not because it's
hardened for anything beyond the box it runs on.

## Reaching it from another PC on your LAN

By default multiclaude is loopback-only. To let another machine on your network
open it, run **`.\scripts\start-multiclaude-lan.ps1`** — it binds to all
interfaces, prints your LAN URLs (e.g. `http://192.168.1.20:3001`), and (once,
from an **admin** PowerShell) you may need to allow the port through the
firewall:

```
New-NetFirewallRule -DisplayName "multiclaude LAN" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3001 -Profile Any
```

(`-Profile Any` works whether Windows labels your network Private or Public —
home Ethernet is often Public. If you also run a VPN like NordVPN, make sure
its "allow LAN / local network" setting is on, or it may block other machines
from reaching this PC.)

⚠️ **This exposes a real shell on this PC to anyone who can reach the port —
only do it on a network you trust.** Even in LAN mode, requests are still
restricted to this machine's own addresses, so random websites and
DNS-rebinding attacks are refused; but anyone who can load the LAN URL gets a
shell. It is off unless you explicitly start it this way.

## Prerequisites

- **Node.js 22 or newer** — https://nodejs.org
- **git** — https://git-scm.com
- **PowerShell 7** (`pwsh`) — optional but recommended: `winget install Microsoft.PowerShell`.
  If it's not installed, the app falls back to built-in Windows PowerShell.
- **gh** (GitHub CLI) — needed for the GitHub repo picker: `winget install GitHub.cli`,
  then `gh auth login` once.

## Install

```
npm install
```

## Run — the easy way

Double-click **`start-multiclaude.cmd`** in the project folder. It builds the
app if needed, starts the server invisibly in the background, and opens your
browser at http://127.0.0.1:3001. Run it again any time — if the server is
already up it just opens the browser.

Want it always available? Run once in PowerShell:

```
.\scripts\install-startup.ps1     # start hidden at every Windows login
.\scripts\uninstall-startup.ps1   # undo
```

To stop the server (this kills every terminal session it holds):

```
.\scripts\stop-multiclaude.ps1
```

## Run — for development

```
npm run dev
```

Then open **http://127.0.0.1:5173**. Code changes reload live. Or build and
run the production version yourself: `npm run build` then `npm start`
(http://127.0.0.1:3001).

## Using it

- **Home screen.** With no sessions open, multiclaude shows a home screen: a
  grid of **recent workspaces** you can click to drop straight back into a
  session there (it opens the folder and starts Claude), plus New session and
  Blank shell. **Clear history** forgets the recent list. Close every tab and
  you're back at the home screen.
- **＋ New session** — start a terminal in a local folder (browse or pick a
  recent one), in a GitHub repo (cloned via `gh` into
  `~\multiclaude-workspaces\`), or as a blank shell. In the folder browser you
  can also type or paste a path directly and press Enter, or **create a new
  folder** on the spot and open a session in it — optionally making it a **git
  repo** (on by default), dropping in a **starter file** (e.g. a `CLAUDE.md`
  with project instructions, or any freeform file), and even **publishing it to
  GitHub** (creates the repo with an initial commit and pushes). Every option
  in the dialog has a detailed tooltip on hover. On the GitHub tab you can
  **create a brand-new repo** (pick private/public each time; it's initialised
  with a README, cloned into your workspace, and opened). Options: auto-start
  `claude` (on by default), skip its permission prompts
  (`--dangerously-skip-permissions`, on by default), and/or run it in a git
  worktree so parallel sessions on the same repo don't collide.
- **Tabs and splits** — drag a tab to any edge to split the window; drag the
  dividers to resize. The Single / 2-up / 2×2 / 3×3 buttons rearrange
  everything into a preset grid. The layout is saved automatically and comes back after
  a browser refresh or restart.
- **Right-click a tab → "Browse to folder…"** to point that shell at a
  different folder: it `cd`s the shell there and renames the tab to the folder
  (handy for blank shells you started in your home directory).
- **Closing a tab** asks whether to kill the session or keep it running in
  the background. Background sessions are listed under **Sessions**, where you
  can reattach, kill, kill-all, **duplicate** (a new session in the same
  folder), **open the folder** in Explorer, or **copy its path**. A green
  **git** badge marks sessions whose folder is a git repo.
- **Broadcast** (toolbar) types one command, plus Enter, into every live
  session at once — e.g. send the same instruction to every Claude, or run
  `/clear` everywhere. One-click presets cover common Claude slash commands
  (`/clear`, `/compact`, `/cost`, `/status`, `/model`, `/exit`), shell commands
  (`cls`, `git status`, `git pull`, `git fetch --all`), and controls (Enter,
  Ctrl-C interrupt, Esc).
- **Refresh brings everything back.** On load, multiclaude reconciles the saved
  layout against the sessions the server is actually running: every live
  session is guaranteed a tab, so a browser refresh never leaves a running
  session stranded with no pane. (A side effect: sessions you "kept running in
  the background" reappear as tabs after a refresh — a reload shows you
  everything that's alive.)
- **Workspace restore across a restart.** A browser refresh keeps sessions
  because the server owns them — but a *server* restart (reboot, crash, or a
  code reload) ends the shells. multiclaude remembers each session's folder and
  startup command, and on the next launch **asks** whether to restore them:
  "Restore N sessions from last time?" Restoring reopens the shells in the same
  folders and re-runs whatever they auto-started (e.g. `claude`) — the running
  program can't be brought back to life, but you land back in your workspace
  instead of rebuilding it. Sessions you explicitly killed aren't offered.
- **Tab titles** show the folder name and current git branch, refreshed
  automatically. Double-click a tab to rename it yourself (auto-renaming
  then leaves it alone). A green dot appears on a background tab when its
  session rings the terminal bell — which is what Claude Code does when it
  finishes and wants your attention.
- **Attention routing.** The number of sessions wanting attention shows up in
  the **browser tab title** (`(2) multiclaude`) and as a red badge on the
  **favicon**, so you can tell from your browser's tab strip — even when
  multiclaude isn't the tab you're looking at. The Sessions list floats those
  sessions to the top with a green dot. Turn on **desktop notifications** in
  Settings to get a popup when a background session finishes.
- **Images**: paste a screenshot (Ctrl+V) or drop an image file onto a
  terminal. It's saved locally and the file path is typed into the terminal,
  which is how Claude Code reads images. Saved images are pruned after 7 days.
- **Copy/paste**: selecting text copies it automatically; Ctrl+V pastes
  (multi-line pastes are bracketed, so they don't run line by line).
- **Search**: Ctrl+Shift+F searches the visible terminal's scrollback.
- **Health** shows the server PID/uptime and every session's PID, folder and
  uptime. **Settings** has font size and scrollback length.

- **Command palette (`Ctrl+K`).** A fuzzy quick-switcher: start typing to jump
  to any session by name or folder, reattach a background session, or run any
  action (new session, broadcast, layouts, health, settings, kill all). Arrow
  keys to move, Enter to run, Esc to close. Built for when you have a lot of
  panes and don't want to hunt for the right tab. There's also a **Search**
  button in the toolbar.

Keyboard shortcuts: `Ctrl+K` command palette, `Ctrl+Shift+F` search,
`Ctrl+Shift+C` copy selection, `Ctrl+Shift+T` new session, `Ctrl+Tab` cycle
panes. (Some browsers reserve `Ctrl+Tab`/`Ctrl+Shift+T` for themselves and
won't pass them to the page.)

## Autonomous runs

A terminal pane is you driving. An **Autonomous** pane is a work order: Claude
executes a written plan unattended, one step per turn, committing and pushing
each step, and stops when it's done or genuinely stuck. You watch it happen in
the tab — or read the log in the morning.

### The contract

Three files in the target repo are the entire protocol. They're plain markdown,
they live in the repo, and they survive anything:

| File | What it is |
|---|---|
| `PLAN.md` | The work order — 5–15 ordered steps, each with a done condition that can be *checked by running a command*. No step may need a decision from you. |
| `PROGRESS.md` | The run's log — one timestamped entry per verified step, appended, never rewritten. A populated `## Blockers` section is how the run tells you it's stuck. |
| `DONE` | The finish line. When it appears, the run stops. Its absence is what authorises a run to start. |

Nothing else is remembered between turns. Every turn re-reads these files from
disk, so a run survives a crash, a server restart, or a reboot with no loss of
context — the state is the repo, not the process.

### Launching one

**⚙ Autonomous** in the toolbar. The dialog runs a **pre-flight** first and
won't let you launch until it's green:

- the project directory is a git repo, and its **working tree is clean**
  (a clean tree is what makes Rollback safe — see below)
- `PLAN.md` and `PROGRESS.md` exist at the repo root
- every path mentioned in `PLAN.md` stays inside the sandbox the run is granted
- the **run discipline** block is installed in your global `CLAUDE.md`
- the `claude` CLI is present, with its version

Failed checks say how to fix them, and most fix in one click: scaffold
`PLAN.md`/`PROGRESS.md` from templates, or append the discipline block. If you
don't have a plan yet, **Draft a plan with Claude** opens a primed interactive
session to co-author `PLAN.md` with you, then come back and launch.

Options: **model** (`sonnet` default, `opus`, or `fable` — most capable and
priciest), a **budget cap** in USD (a hard per-invocation ceiling), **additional
directories** the run may touch (with quick-pick chips for sibling folders,
remembered per project), and **extra Bash allow-rules** to widen the default
`git` / `npm` / `npx` / `node` scope.

### Everything a run does is reversible

Launching first writes a **rollback tag** (`multiclaude-launch-<task>-<unix>`),
adds `/.multiclaude/` to `.gitignore`, and pins a session UUID under
`.multiclaude/<task>/`. **Rollback** in the tab undoes the entire run —
`git reset --hard <tag>` plus `git clean -fd` — back to the moment before it
started. That's also why pre-flight insists on a clean tree: rollback would
otherwise destroy work that had nothing to do with the run.

### Watching it

The tab shows a live event log (what Claude read, wrote, ran, and committed),
with `PROGRESS.md` and `PLAN.md` rendered beside it, refreshed as they change.
The header carries the state badge, the current step, a turn clock, the running
cost, and the **cache-hit %** (the share of input tokens served from the prompt
cache — higher means cheaper resumes). Controls: **Pause**, **Resume**,
**Kill**, **Rollback**.

### When things go wrong

The supervisor's whole job is that a run doesn't quietly die at 2am. In order:

1. **A failed turn is retried** on the same model — 5s, then 20s, then 60s. Most
   failures are transient (a dropped connection mid-response), and a retry
   clears them.
2. **Still failing → the model steps down**: `fable` → `opus` → `sonnet`, with an
   amber banner naming what it fell back from and why. It never switches back up
   on its own. A pinned model id (e.g. `claude-fable-5`) is never substituted.
3. **Out of models, and it's a usage limit** → it sleeps until the limit resets
   (parsed from the message) and resumes on its own.
4. **Dead anyway** → whatever was half-written is committed as one marked
   `wip: partial Step N — run aborted (<reason>)` commit, so the work is visible
   in `git log` and the tree is clean for the next run. The error banner carries
   the tail of the real output, so a failure is never blank.
5. **Claude writes a Blocker** → the run stops and the tab says so. This is the
   good outcome when a plan is wrong: it stops and asks instead of guessing its
   way into a mess overnight.

### Runs outlive everything

A run belongs to the server, not the tab — and its record outlives even the
server. Close the tab, refresh, restart the machine: **Past runs** at the top of
the Autonomous dialog lists every run with its state, model, step and cost, and
reopens its tab on click. Reopening only shows the tab; nothing restarts until
you press **Resume**, which continues the same conversation from its pinned
session UUID rather than starting over.

### Work is pushed, not just committed

Each verified step is committed *and pushed*, so a night's work never exists
only on one disk. A push that fails (no remote, no upstream, missing scope) is
deliberately **not** treated as a blocker — the run notes it in `PROGRESS.md`
and carries on, since the commits are still safe locally. The one thing never
pushed is the `wip:` salvage commit above: that code is unverified by
definition.

## Where things live

| What | Where |
|---|---|
| Layout, settings, recent folders | `%LOCALAPPDATA%\multiclaude\state.json` |
| Pasted images | `%LOCALAPPDATA%\multiclaude\images\` (pruned after 7 days) |
| Cloned GitHub repos | `%USERPROFILE%\multiclaude-workspaces\` (override with `MULTICLAUDE_WORKSPACES`) |
| Autonomous run state (pinned session UUID) | `.multiclaude/<task>/` in the target repo (gitignored automatically) |
| Autonomous run registry (survives restarts) | `%LOCALAPPDATA%\multiclaude\state.json` |
| Rollback points | git tags — `multiclaude-launch-<task>-<unix>` |

## How it works (one paragraph)

A Node server spawns PowerShell through ConPTY (the same Windows plumbing VS
Code's terminal uses) via `node-pty`. Your browser opens one WebSocket per
terminal pane: keystrokes go down, screen output comes up, and resize events
tell the shell its real window size. The server keeps ~500 KB of recent output
per session in memory, so a reconnecting browser can replay what it missed.
Sessions belong to the server, not the browser — the browser is a viewer.

An autonomous run is the same shape one level up: instead of a pty, the server
supervises repeated `claude -p` invocations pinned to one session UUID
(`--resume` after the first), parses their stream-json output into the event log
you see, and decides what to do when one fails. It never parses Claude's
*reasoning* — only the mechanics: which step, what it cost, and whether the turn
succeeded. The plan and the log are files in your repo, not state in this app.

## Troubleshooting

**`npm install` fails building `node-pty`.** node-pty is native code. If
there's no prebuilt binary for your Node version, npm compiles it, which needs
the Visual Studio Build Tools. Fix: install them with
`winget install Microsoft.VisualStudio.2022.BuildTools` (select the
"Desktop development with C++" workload), then run `npm install` again.

**Browser says "This site can't be reached".** The server isn't running.
Start it with `npm run dev` (or `npm start` for the production build) and
leave that window open — the app only exists while it runs.

**"Connection lost — reconnecting…" in a pane.** The server stopped or
restarted. When it's back, panes reattach automatically and replay output.

**GitHub tab says gh isn't installed / signed in.** `winget install GitHub.cli`
then `gh auth login`.

**Port already in use.** Set a different port:
`$env:MULTICLAUDE_PORT = "3002"; npm start` (and in dev, update the proxy
target in `vite.config.ts` to match).

## Testing the plumbing without a browser

With the server running:

```
node scripts/e2e-test.mjs        # terminal I/O + scrollback replay over WebSocket
node scripts/api-test.mjs        # session create/list/kill, state persistence
node scripts/launcher-test.mjs   # folder browser validation, gh integration
node scripts/images-test.mjs     # image upload endpoint
node scripts/security-test.mjs   # cross-origin defence (REST + WebSocket)
node scripts/features-test.mjs   # broadcast, reveal, bell field, auto-claude timing
node scripts/create-test.mjs     # create-folder + create-repo validation
npx tsx scripts/reconcile-test.ts # layout↔live-session reconciliation on load
node scripts/git-features-test.mjs # git-init, isRepo detection, publish validation
node scripts/restore-test.mjs    # workspace-restore API (full flow needs a restart)
```

Autonomous runs are covered separately. These are deterministic — they drive the
supervisor against a fake `claude` stub, so they cost nothing and touch no
network:

```
npx tsx scripts/loop-test.ts        # the supervisor: retry ladder, model fallback,
                                    # usage-limit sleep, wip-salvage, DONE, blockers
npx tsx scripts/preflight-test.ts   # pre-flight checks
npx tsx scripts/launch-test.ts      # rollback tag, state dir, gitignore
npx tsx scripts/controls-test.ts    # pause / resume / kill / rollback
npx tsx scripts/discipline-test.ts  # the CLAUDE.md discipline block append
npx tsx scripts/scaffold-test.ts    # PLAN.md / PROGRESS.md templates
npx tsx scripts/pathscan-test.ts    # PLAN.md sandbox path scan
npx tsx scripts/autonomous-relaunch-test.ts  # pinned UUID + --resume args
npx tsx scripts/autonomous-persist-test.ts   # run registry survives a restart
npx tsx scripts/streamparse-test.ts # stream-json framing
```
