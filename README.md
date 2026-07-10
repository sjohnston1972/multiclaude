# multiclaude

Run and manage multiple Claude Code sessions in a single browser window. The
server holds real PowerShell terminals; the browser is just a viewer. Close or
refresh the browser and your sessions keep running — reconnecting reattaches
and replays recent output, like plugging back into a console port.

**Security note:** this app gives whoever connects a real shell on your
machine. It listens on `127.0.0.1` only and refuses to start on any other
address. Never expose it through a tunnel or reverse proxy.

## Prerequisites

- **Node.js 22 or newer** — https://nodejs.org
- **git** — https://git-scm.com
- **PowerShell 7** (`pwsh`) — optional but recommended: `winget install Microsoft.PowerShell`.
  If it's not installed, the app falls back to built-in Windows PowerShell.
- **gh** (GitHub CLI) — only needed from Phase 3 onward for the repo picker.

## Install

```
npm install
```

## Run (development)

```
npm run dev
```

Then open **http://127.0.0.1:5173** in your browser. You get a full-screen
PowerShell terminal. Type `claude` to start a Claude Code session in it.

## Run (production build)

```
npm run build
npm start
```

Then open **http://127.0.0.1:3001**. Same app, single process, no dev tooling.

## How it works (one paragraph)

A Node server spawns PowerShell through ConPTY (the same Windows plumbing VS
Code's terminal uses) via `node-pty`. Your browser opens one WebSocket per
terminal pane: keystrokes go down, screen output comes up, and resize events
tell the shell its real window size. The server keeps ~500 KB of recent output
per session in memory, so a reconnecting browser can replay what it missed.

## Troubleshooting

**`npm install` fails building `node-pty`.** node-pty is native code. If
there's no prebuilt binary for your Node version, npm compiles it, which needs
the Visual Studio Build Tools. Fix: install them with
`winget install Microsoft.VisualStudio.2022.BuildTools` (select the
"Desktop development with C++" workload), then run `npm install` again.

**Browser says "Connection lost — reconnecting…" forever.** The server isn't
running. Start it with `npm run dev` (or `npm start` for the production build).

**Terminal looks garbled after resizing.** Refresh the page — the server
replays the session output at the new size.

**Port already in use.** Set a different port:
`$env:MULTICLAUDE_PORT = "3002"; npm start` (and in dev, update the proxy
target in `vite.config.ts` to match).

## Testing the plumbing without a browser

With the server running:

```
node scripts/e2e-test.mjs
```

This attaches over WebSocket, runs a command in the shell, checks the output
comes back, then reattaches to verify scrollback replay.
