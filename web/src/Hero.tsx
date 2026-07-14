import { useEffect, useState } from "react";
import { api } from "./api";

interface RecentWorkspace {
  path: string;
  name: string;
  isRepo: boolean;
  autonomous?: "completed" | "ready" | "drafting" | "none";
}

const AUTO_BADGE: Record<string, { label: string; cls: string }> = {
  ready: { label: "⚙ autonomous", cls: "bg-blue-900/70 text-blue-300" },
  completed: { label: "⚙ done", cls: "bg-emerald-900/70 text-emerald-300" },
  drafting: { label: "⚙ drafting", cls: "bg-neutral-800 text-neutral-400" },
};

/**
 * The home screen shown when no sessions are open. Framed as a terminal
 * welcome: a live prompt over a grid of recent workspaces you can drop back
 * into with one click (opens a session there and starts claude).
 */
export default function Hero({
  onOpenFolder,
  onNewSession,
  onBlankShell,
}: {
  onOpenFolder: (cwd: string) => void;
  onNewSession: () => void;
  onBlankShell: () => void;
}) {
  const [recent, setRecent] = useState<RecentWorkspace[] | null>(null);

  useEffect(() => {
    api<RecentWorkspace[]>("/api/recent")
      .then(setRecent)
      .catch(() => setRecent([]));
  }, []);

  return (
    <div className="h-full w-full overflow-y-auto bg-[#0a0a0a]">
      <div className="mx-auto flex min-h-full max-w-4xl flex-col justify-center px-6 py-16">
        {/* Prompt hero */}
        <div className="mb-10">
          <p className="font-mono text-sm text-neutral-500">
            <span className="text-emerald-400">steven</span>
            <span className="text-neutral-600">@</span>
            <span className="text-orange-400">multiclaude</span>
            <span className="text-neutral-600"> ~ </span>
            <span className="text-neutral-500">$</span>
            <span className="ml-1 inline-block h-[1.1em] w-[0.55em] translate-y-[0.15em] bg-neutral-300 mc-caret" />
          </p>
          <h1 className="mt-3 font-mono text-3xl font-bold tracking-tight text-neutral-100 sm:text-4xl">
            Pick up where you left off.
          </h1>
          <p className="mt-2 max-w-prose text-sm text-neutral-400">
            No sessions are open. Reconnect to a recent workspace, or start
            somewhere new — each opens a real terminal running Claude Code.
          </p>
        </div>

        {/* Recent workspace tiles */}
        {recent === null ? (
          <p className="font-mono text-sm text-neutral-600">loading recent workspaces…</p>
        ) : recent.length > 0 ? (
          <>
            <div className="mb-2 flex items-center justify-between">
              <p className="font-mono text-[11px] uppercase tracking-widest text-neutral-600">
                Recent workspaces
              </p>
              <button
                onClick={() => {
                  api("/api/recent", { method: "DELETE" })
                    .then(() => setRecent([]))
                    .catch(() => {});
                }}
                className="font-mono text-[11px] text-neutral-600 hover:text-neutral-300"
                title="Forget all recent workspaces"
              >
                clear history
              </button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {recent.map((w) => (
                <button
                  key={w.path}
                  onClick={() => onOpenFolder(w.path)}
                  title={`Open a session in ${w.path}`}
                  className="group flex items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-3 text-left transition-colors hover:border-orange-500/50 hover:bg-neutral-800/60"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium text-neutral-100">{w.name}</span>
                      {w.isRepo && (
                        <span className="rounded bg-emerald-900/70 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
                          git
                        </span>
                      )}
                      {w.autonomous && w.autonomous !== "none" && AUTO_BADGE[w.autonomous] && (
                        <span
                          title="This repo has autonomous-run state files (PLAN.md / PROGRESS.md / DONE)"
                          className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${AUTO_BADGE[w.autonomous].cls}`}
                        >
                          {AUTO_BADGE[w.autonomous].label}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-xs text-neutral-500">
                      {w.path}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-xs text-neutral-600 transition-colors group-hover:text-orange-400">
                    Open ▸
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="rounded-lg border border-dashed border-neutral-800 px-4 py-6 text-center text-sm text-neutral-500">
            No recent workspaces yet. Open your first session below.
          </p>
        )}

        {/* Quick actions */}
        <div className="mt-8 flex flex-wrap gap-2">
          <button
            onClick={onNewSession}
            className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-500"
          >
            ＋ New session…
          </button>
          <button
            onClick={onBlankShell}
            className="rounded-lg border border-neutral-700 px-4 py-2 text-sm text-neutral-200 hover:bg-neutral-800"
          >
            Blank shell
          </button>
          <span className="ml-auto self-center font-mono text-xs text-neutral-600">
            press <kbd className="rounded bg-neutral-800 px-1 text-neutral-400">Ctrl K</kbd> to search
          </span>
        </div>
      </div>
    </div>
  );
}
