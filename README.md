# multiclaude

Run and manage multiple Claude Code sessions in a single browser window —
tabs, draggable split layouts, each pane a full real PowerShell terminal. The
server holds the terminals; the browser is just a viewer. Close or refresh the
browser and your sessions keep running — reconnecting reattaches and replays
recent output, like plugging back into a console port.

**Security note:** this app gives whoever connects a real shell on your
machine. It listens on `127.0.0.1` only and refuses to start on any other
address. It also rejects any REST or WebSocket request whose browser origin
isn't loopback, so a random website you visit can't reach in and spawn a
shell through your browser. Never expose it through a tunnel or reverse proxy.

## Reaching it from another PC on your LAN

By default multiclaude is loopback-only. To let another machine on your network
open it, run **`.\scripts\start-multiclaude-lan.ps1`** — it binds to all
interfaces, prints your LAN URLs (e.g. `http://192.168.1.20:3001`), and (once,
from an **admin** PowerShell) you may need to allow the port through the
firewall:

```
New-NetFirewallRule -DisplayName "multiclaude LAN" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3001 -Profile Private
```

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

## Where things live

| What | Where |
|---|---|
| Layout, settings, recent folders | `%LOCALAPPDATA%\multiclaude\state.json` |
| Pasted images | `%LOCALAPPDATA%\multiclaude\images\` (pruned after 7 days) |
| Cloned GitHub repos | `%USERPROFILE%\multiclaude-workspaces\` (override with `MULTICLAUDE_WORKSPACES`) |

## How it works (one paragraph)

A Node server spawns PowerShell through ConPTY (the same Windows plumbing VS
Code's terminal uses) via `node-pty`. Your browser opens one WebSocket per
terminal pane: keystrokes go down, screen output comes up, and resize events
tell the shell its real window size. The server keeps ~500 KB of recent output
per session in memory, so a reconnecting browser can replay what it missed.
Sessions belong to the server, not the browser — the browser is a viewer.

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
