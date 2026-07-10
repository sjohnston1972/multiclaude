import { useEffect, useState } from "react";
import { api, SessionInfo } from "./api";
import { Button, Modal } from "./components";

interface BrowseResult {
  path: string | null;
  parent: string | null;
  home: string;
  dirs: string[];
  drives: string[];
  recent: string[];
}

/** Last path segment, for compact button labels ("multiclaude", not the full path). */
function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

interface Repo {
  name: string;
  nameWithOwner: string;
  updatedAt: string;
  cloned: boolean;
}

type Mode = "folder" | "github" | "blank";

/**
 * The launcher: pick where a new terminal starts — a local folder (browsed
 * server-side), a GitHub repo (cloned via gh into the workspace root), or a
 * blank shell in the home directory.
 */
export default function NewSessionDialog({
  onCreated,
  onClose,
}: {
  onCreated: (s: SessionInfo) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("folder");
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [ghError, setGhError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoClaude, setAutoClaude] = useState(true);
  const [skipPermissions, setSkipPermissions] = useState(true);
  const [useWorktree, setUseWorktree] = useState(false);
  const [worktreeName, setWorktreeName] = useState("");

  // "Create new folder" (folder tab) and "Create new repo" (github tab)
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [showCreateRepo, setShowCreateRepo] = useState(false);
  const [repoName, setRepoName] = useState("");
  const [repoVisibility, setRepoVisibility] = useState<"private" | "public" | null>(null);
  const [repoDesc, setRepoDesc] = useState("");

  const loadBrowse = (path?: string) => {
    setError(null);
    api<BrowseResult>(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`)
      .then((b) => {
        setBrowse(b);
        setPathInput(b.path ?? "");
      })
      .catch((e) => setError(e.message));
  };

  useEffect(() => loadBrowse(), []);

  useEffect(() => {
    if (mode === "github" && repos === null && !ghError) {
      api<{ repos: Repo[] }>("/api/github/repos")
        .then((r) => setRepos(r.repos))
        .catch((e) => setGhError(e.message));
    }
  }, [mode, repos, ghError]);

  const createSession = async (cwd?: string) => {
    setBusy("Starting session…");
    setError(null);
    try {
      const worktree = autoClaude && useWorktree
        ? worktreeName.trim() || `mc-${Math.random().toString(36).slice(2, 6)}`
        : null;
      const s = await api<SessionInfo>("/api/sessions", {
        method: "POST",
        body: { cwd, autoClaude, worktree, skipPermissions },
      });
      onCreated(s);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const createFolderAndOpen = async () => {
    if (!browse?.path) return;
    setBusy("Creating folder…");
    setError(null);
    try {
      const r = await api<{ path: string }>("/api/mkdir", {
        method: "POST",
        body: { parent: browse.path, name: newFolderName.trim() },
      });
      await createSession(r.path);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const createRepoAndOpen = async () => {
    setBusy(`Creating ${repoName.trim()} on GitHub…`);
    setError(null);
    try {
      const r = await api<{ path: string }>("/api/github/create", {
        method: "POST",
        body: { name: repoName.trim(), visibility: repoVisibility, description: repoDesc.trim() },
      });
      await createSession(r.path);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const cloneAndOpen = async (repo: Repo) => {
    setBusy(repo.cloned ? "Opening existing clone…" : `Cloning ${repo.nameWithOwner}…`);
    setError(null);
    try {
      const r = await api<{ path: string; existing: boolean }>("/api/github/clone", {
        method: "POST",
        body: { nameWithOwner: repo.nameWithOwner },
      });
      await createSession(r.path);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const modeTab = (m: Mode, label: string) => (
    <button
      onClick={() => setMode(m)}
      className={`rounded-t px-3 py-1.5 text-sm ${
        mode === m
          ? "bg-neutral-800 font-medium text-white"
          : "text-neutral-400 hover:text-neutral-200"
      }`}
    >
      {label}
    </button>
  );

  return (
    <Modal title="New session" onClose={onClose} wide>
      <div className="mb-3 flex gap-1 border-b border-neutral-700">
        {modeTab("folder", "Local folder")}
        {modeTab("github", "GitHub repo")}
        {modeTab("blank", "Blank shell")}
      </div>

      {error && <p className="mb-2 rounded bg-red-950 px-3 py-1.5 text-red-300">{error}</p>}
      {busy && <p className="mb-2 rounded bg-blue-950 px-3 py-1.5 text-blue-300">{busy}</p>}

      {mode === "folder" && browse && (
        <div>
          {/* Navigation bar: Up / Home / editable path (type or paste, Enter to go) */}
          <div className="mb-2 flex items-center gap-1.5">
            <Button
              onClick={() => (browse.parent ? loadBrowse(browse.parent) : loadBrowse(undefined))}
              disabled={browse.path === null}
              title="Parent folder"
            >
              ⬆ Up
            </Button>
            <Button onClick={() => loadBrowse(browse.home)} title={browse.home}>
              🏠 Home
            </Button>
            <input
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && pathInput.trim()) loadBrowse(pathInput.trim());
              }}
              placeholder="Type or paste a path, press Enter"
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm text-neutral-100 outline-none focus:border-blue-600"
            />
          </div>

          {browse.path === null ? (
            <>
              {browse.recent.length > 0 && (
                <>
                  <p className="mb-1 text-xs uppercase text-neutral-500">Recent folders</p>
                  <div className="mb-3 flex flex-col gap-1">
                    {browse.recent.map((f) => (
                      <button
                        key={f}
                        onClick={() => loadBrowse(f)}
                        className="truncate rounded bg-neutral-800 px-3 py-1.5 text-left hover:bg-neutral-700"
                        title={`Browse ${f}`}
                      >
                        📁 {f}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <p className="mb-1 text-xs uppercase text-neutral-500">Drives</p>
              <div className="flex flex-wrap gap-2">
                {browse.drives.map((d) => (
                  <button
                    key={d}
                    onClick={() => loadBrowse(d)}
                    className="rounded bg-neutral-800 px-4 py-2 hover:bg-neutral-700"
                  >
                    💾 {d}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="mb-2 max-h-56 overflow-y-auto rounded border border-neutral-800">
                {browse.dirs.length === 0 ? (
                  <p className="px-3 py-2 text-neutral-500">No subfolders</p>
                ) : (
                  browse.dirs.map((d) => (
                    <button
                      key={d}
                      onClick={() => loadBrowse(`${browse.path}\\${d}`)}
                      className="block w-full truncate px-3 py-1.5 text-left hover:bg-neutral-800"
                    >
                      📁 {d}
                    </button>
                  ))
                )}
              </div>
              {/* Create a new subfolder here, then open a session in it. */}
              {showNewFolder ? (
                <div className="mb-2 flex items-center gap-2 rounded border border-neutral-700 bg-neutral-800/50 p-2">
                  <input
                    autoFocus
                    type="text"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newFolderName.trim()) void createFolderAndOpen();
                      else if (e.key === "Escape") setShowNewFolder(false);
                    }}
                    placeholder="New folder name"
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm outline-none focus:border-blue-600"
                  />
                  <Button
                    kind="primary"
                    onClick={() => void createFolderAndOpen()}
                    disabled={!!busy || !newFolderName.trim()}
                  >
                    Create &amp; open
                  </Button>
                  <Button onClick={() => setShowNewFolder(false)}>Cancel</Button>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setNewFolderName("");
                    setShowNewFolder(true);
                  }}
                  className="mb-2 text-sm text-neutral-400 hover:text-neutral-200"
                >
                  ＋ New folder here
                </button>
              )}

              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs text-neutral-500" title={browse.path}>
                  {browse.path}
                </span>
                <Button
                  kind="primary"
                  onClick={() => void createSession(browse.path!)}
                  disabled={!!busy}
                  title={`Start a session in ${browse.path}`}
                >
                  ▶ Start session in "{basename(browse.path)}"
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {mode === "github" && (
        <div>
          {/* Create a brand-new repo on GitHub, then clone + open it. */}
          <div className="mb-3 rounded border border-neutral-700 bg-neutral-800/50 p-2">
            {showCreateRepo ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    type="text"
                    value={repoName}
                    onChange={(e) => setRepoName(e.target.value)}
                    placeholder="new-repo-name"
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm outline-none focus:border-blue-600"
                  />
                  <label className="flex items-center gap-1 text-sm">
                    <input
                      type="radio"
                      name="repo-vis"
                      checked={repoVisibility === "private"}
                      onChange={() => setRepoVisibility("private")}
                    />
                    Private
                  </label>
                  <label className="flex items-center gap-1 text-sm">
                    <input
                      type="radio"
                      name="repo-vis"
                      checked={repoVisibility === "public"}
                      onChange={() => setRepoVisibility("public")}
                    />
                    Public
                  </label>
                </div>
                <input
                  type="text"
                  value={repoDesc}
                  onChange={(e) => setRepoDesc(e.target.value)}
                  placeholder="Description (optional)"
                  className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm outline-none focus:border-blue-600"
                />
                <div className="flex items-center gap-2">
                  <Button
                    kind="primary"
                    onClick={() => void createRepoAndOpen()}
                    disabled={!!busy || !repoName.trim() || repoVisibility === null}
                    title={repoVisibility === null ? "Choose Private or Public first" : undefined}
                  >
                    Create &amp; open
                  </Button>
                  <Button onClick={() => setShowCreateRepo(false)}>Cancel</Button>
                  <span className="text-xs text-neutral-500">
                    Initialised with a README, cloned into your workspace.
                  </span>
                </div>
              </div>
            ) : (
              <button
                onClick={() => {
                  setRepoName("");
                  setRepoDesc("");
                  setRepoVisibility(null);
                  setShowCreateRepo(true);
                }}
                className="text-sm text-neutral-300 hover:text-white"
              >
                ＋ Create a new repo on GitHub
              </button>
            )}
          </div>

          {ghError ? (
            <p className="rounded bg-amber-950 px-3 py-2 text-amber-300">{ghError}</p>
          ) : repos === null ? (
            <p className="text-neutral-400">Loading your repositories…</p>
          ) : repos.length === 0 ? (
            <p className="text-neutral-400">No repositories found for your GitHub account.</p>
          ) : (
            <div className="max-h-72 overflow-y-auto rounded border border-neutral-800">
              {repos.map((r) => (
                <div
                  key={r.nameWithOwner}
                  className="flex items-center justify-between border-b border-neutral-800 px-3 py-1.5 last:border-b-0"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{r.nameWithOwner}</p>
                    <p className="text-xs text-neutral-500">
                      updated {new Date(r.updatedAt).toLocaleDateString()}
                      {r.cloned && " · already cloned"}
                    </p>
                  </div>
                  <Button kind="primary" onClick={() => void cloneAndOpen(r)} disabled={!!busy}>
                    {r.cloned ? "Open existing" : "Clone & open"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {mode === "blank" && (
        <div>
          <p className="mb-3 text-neutral-400">
            A plain PowerShell window in your home directory.
          </p>
          <Button kind="primary" onClick={() => void createSession()} disabled={!!busy}>
            Open blank shell
          </Button>
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2 border-t border-neutral-700 pt-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={autoClaude}
            onChange={(e) => setAutoClaude(e.target.checked)}
          />
          <span>
            Auto-start <code className="rounded bg-neutral-800 px-1">claude</code> in the new
            session
          </span>
        </label>
        <label className={`flex items-center gap-2 ${!autoClaude ? "opacity-40" : ""}`}>
          <input
            type="checkbox"
            checked={skipPermissions}
            disabled={!autoClaude}
            onChange={(e) => setSkipPermissions(e.target.checked)}
          />
          <span>
            Skip permission prompts
            <span className="ml-1 text-xs text-neutral-500">
              (--dangerously-skip-permissions)
            </span>
          </span>
        </label>
        <label className={`flex items-center gap-2 ${!autoClaude ? "opacity-40" : ""}`}>
          <input
            type="checkbox"
            checked={useWorktree}
            disabled={!autoClaude}
            onChange={(e) => setUseWorktree(e.target.checked)}
          />
          <span>Start in a git worktree</span>
          {useWorktree && autoClaude && (
            <input
              type="text"
              value={worktreeName}
              onChange={(e) => setWorktreeName(e.target.value)}
              placeholder="name (optional)"
              className="w-40 rounded border border-neutral-700 bg-neutral-800 px-2 py-0.5 text-sm"
            />
          )}
        </label>
      </div>
    </Modal>
  );
}
