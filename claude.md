# multiclaude

A local web application for running and managing multiple Claude Code sessions in a single browser window. Think: lots of small PowerShell windows — tabs, draggable/resizable split layouts — each one a full, real terminal, most of them running `claude`.

Repository: https://github.com/sjohnston1972/multiclaude

## About the developer

Steven is a senior network architect, not a software developer. He understands systems, protocols, and infrastructure deeply, but not code structure or programming idioms.

- Explain **what** you are building and **why** before writing code, in one or two short paragraphs. Use networking analogies where they fit (WebSocket ≈ persistent TCP session; the pty server ≈ a terminal server; reattach ≈ console port).
- Prefer boring, well-documented libraries over clever custom code.
- Small increments. After each working milestone, stop, tell Steven how to run and verify it, and wait for confirmation before continuing.
- Never assume he will "read the code to understand" — the explanation in chat IS the documentation for him.

## What this app is

- A **Node.js server** that runs locally on Steven's Windows machine. It spawns real PowerShell processes via ConPTY and owns their lifecycle.
- A **browser UI** that connects to the server and renders those terminals. Closing or refreshing the browser must NOT kill sessions — reconnecting reattaches to live sessions and replays recent output.
- Each terminal pane is a genuine shell. Users will mostly run `claude` in them, but the app must not care what runs inside.

## What this app is NOT (non-goals)

- Not multi-user. One user, one machine.
- Not internet-facing. Bind to `127.0.0.1` only. Refuse to start if configured host is not loopback unless `MULTICLAUDE_UNSAFE_HOST=1` is set (and print a loud warning). This app is arbitrary code execution by design; it must never be exposed via Cloudflare Tunnel or any reverse proxy without this being a deliberate, separate decision.
- Not an AI wrapper. Do not parse or intercept Claude Code's output, add API calls, or build chat UI. The terminal IS the interface.
- Not cross-platform (yet). Windows 10/11 first. Don't add macOS/Linux conditionals unless free.

## Tech stack (fixed — do not substitute without asking)

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 LTS + TypeScript | node-pty requires Node; TS catches errors early |
| Backend | Fastify + `ws` (WebSocket) | small, fast, well documented |
| Terminals | `node-pty` (ConPTY) | the standard; powers VS Code's terminal |
| Frontend | React 18 + Vite | standard tooling, fast dev loop |
| Terminal render | `@xterm/xterm` + addons: `fit`, `web-links`, `search`, `unicode11` | real terminal emulation in browser |
| Layout | `flexlayout-react` | tabs + draggable splits + saved layouts in one library |
| Styling | Tailwind CSS | consistent with Steven's other projects |
| State persistence | JSON file in `%LOCALAPPDATA%\multiclaude\` | no database needed |

Default shell: `pwsh.exe` (PowerShell 7) if present, else `powershell.exe`. Detect at startup.

## Architecture

```
Browser (React + xterm.js + flexlayout)
   │  HTTP  → REST API: create/list/kill sessions, browse folders, repos, image upload
   │  WS    → one WebSocket per attached terminal: keystrokes down, output up
   ▼
Node server (Fastify)
   ├─ SessionManager: Map<sessionId, { pty, scrollbackBuffer, meta }>
   │     scrollback = ring buffer, last ~500 KB per session, replayed on reattach
   ├─ spawns pwsh via node-pty in the chosen working directory
   └─ shells run `claude`, `git`, `gh`, or anything else the user types
```

Key behaviours:

- **Sessions outlive the browser.** The server holds the pty. On WebSocket reconnect, replay scrollback then resume live streaming.
- **Resize:** when a pane resizes in the browser, send cols/rows over the WS; call `pty.resize()`. Terminal apps (Claude Code especially) render badly if this is skipped.
- **Clean shutdown:** on server exit, prompt/kill child ptys gracefully; on session close from UI, send Ctrl-C then kill after grace period.

## Features by phase

Build strictly in order. Each phase ends with a working app Steven can run and test.

### Phase 1 — One real terminal in the browser
- Server spawns one PowerShell pty; browser renders it via xterm.js over WS.
- Keyboard input, output streaming, resize handling, correct colours.
- Copy: selecting text copies to clipboard (make this a toggle later; on by default). Paste: Ctrl+V, with bracketed paste enabled so multi-line pastes don't execute line-by-line.
- **Done when:** Steven can run `claude` inside it and have a normal session, including arrow keys, colours, and Ctrl+C.

### Phase 2 — Tabs, splits, persistence
- flexlayout-react: multiple named tabs, drag to split horizontally/vertically, resize dividers, presets (single / 2-up / 2x2 grid).
- New-session button spawns a fresh pty; closing a pane offers "kill session" vs "keep running in background"; a session list panel shows all live sessions (attached or not) with reattach.
- Layout + open sessions persist to the JSON state file; restore on restart of the browser (and, where ptys survived, of live sessions).
- **Done when:** Steven runs three Claude sessions in a 2x2-style layout, refreshes the browser, and everything comes back.

### Phase 3 — Session launcher: folders and GitHub
- "New session" dialog with three sources:
  1. **Local folder** — server-side folder browser (REST endpoint lists directories; never expose raw filesystem to the client beyond directory names). Remember recent folders.
  2. **GitHub repo** — shell out to `gh repo list --json name,owner,updatedAt --limit 50` for a picker; clone with `gh repo clone` into a configurable workspace root (default `~\multiclaude-workspaces\`). If the repo is already cloned there, offer "open existing" instead of recloning. If `gh` is missing or unauthenticated, show a friendly message telling Steven to run `gh auth login` — do not build any OAuth flow.
  3. **Blank shell** — just PowerShell in the home directory.
- Optional checkbox: "start in a git worktree" → runs `claude --worktree <name>` instead of plain `claude`, so parallel sessions on the same repo don't collide.
- Optional checkbox: "auto-start claude" (default on) — types `claude` into the new shell.
- **Done when:** Steven can go from zero to a Claude session in a freshly cloned repo without touching a separate terminal.

### Phase 4 — Images, links, quality of life
- **Image paste:** listen for `paste` events on the focused pane; if the clipboard contains an image, POST it to the server, save to `%LOCALAPPDATA%\multiclaude\images\<timestamp>.png`, then write the quoted file path into the pty input. Claude Code reads the file from the path. Same flow for drag-and-drop image files. Prune images older than 7 days on startup.
- **Links:** `@xterm/addon-web-links` — URLs in output are clickable, open in default browser.
- **Search:** Ctrl+Shift+F in-terminal search via the search addon.
- Keyboard shortcuts: Ctrl+Shift+T new tab, Ctrl+Tab cycle panes, Ctrl+Shift+C explicit copy.
- **Done when:** Steven screenshots an error, pastes it into a pane, and Claude Code sees the image.

### Phase 5 — Polish
- Per-session titles (default: folder name + branch, refreshed periodically via `git branch --show-current`).
- Status indicators per tab: bell/activity dot when a background session produces output (this is how you notice a Claude session finished while you were in another tab).
- Dark theme default; font size setting; scrollback size setting.
- Simple health page listing sessions, PIDs, working dirs, uptime.

## Conventions

- `npm run dev` starts server + Vite together (use `concurrently`). `npm run build` then `npm start` runs the production build. There must always be a one-command way to run the app.
- Keep a `README.md` for Steven in plain language: prerequisites (Node 22, PowerShell 7, git, gh), install, run, troubleshooting (including node-pty native build issues on Windows — prefer prebuilt binaries; document the Visual Studio Build Tools fallback).
- Commits: small, one feature each, conventional style (`feat:`, `fix:`, `docs:`). Never commit to main with failing build. Never run destructive git commands (`push --force`, `reset --hard` on shared branches) without explicit approval.
- Errors must surface in the UI in plain English ("Couldn't start PowerShell 7 — falling back to Windows PowerShell"), never silent console-only failures.

## Security guardrails (repeat: this app spawns shells)

- Listen on 127.0.0.1 only (see non-goals for the escape hatch).
- The folder-browse and image-upload endpoints must validate paths and reject traversal outside allowed roots.
- No telemetry, no external calls except those the user's own shells make.