import { useEffect, useState } from "react";
import { api } from "./api";
import { Button, Modal } from "./components";

interface BrowseResult {
  path: string | null;
  parent: string | null;
  home: string;
  dirs: string[];
  drives: string[];
  recent: string[];
}

/** A standalone folder browser that resolves to a chosen path. */
export default function FolderPickerModal({
  title,
  onPick,
  onClose,
}: {
  title: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const load = (path?: string) => {
    setError(null);
    api<BrowseResult>(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`)
      .then((b) => {
        setBrowse(b);
        setPathInput(b.path ?? "");
      })
      .catch((e) => setError(e.message));
  };

  useEffect(() => load(), []);

  const createFolder = () => {
    if (!browse?.path || !newFolderName.trim()) return;
    api<{ path: string }>("/api/mkdir", {
      method: "POST",
      body: { parent: browse.path, name: newFolderName.trim() },
    })
      .then(() => {
        setShowNewFolder(false);
        setNewFolderName("");
        load(browse.path!); // re-read so the new folder shows up
      })
      .catch((e) => setError(e.message));
  };

  return (
    <Modal title={title} onClose={onClose} wide>
      {error && <p className="mb-2 rounded bg-red-950 px-3 py-1.5 text-red-300">{error}</p>}
      {browse && (
        <div>
          <div className="mb-2 flex items-center gap-1.5">
            <Button
              onClick={() => (browse.parent ? load(browse.parent) : load(undefined))}
              disabled={browse.path === null}
              title="Parent folder"
            >
              ⬆ Up
            </Button>
            <Button onClick={() => load(browse.home)} title={browse.home}>
              🏠 Home
            </Button>
            <Button onClick={() => load(browse.path ?? undefined)} title="Refresh this folder">
              ↻
            </Button>
            <input
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && pathInput.trim()) load(pathInput.trim());
              }}
              placeholder="Type or paste a path, press Enter"
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm text-neutral-100 outline-none focus:border-blue-600"
            />
          </div>

          {browse.path === null ? (
            <div className="flex flex-wrap gap-2">
              {browse.drives.map((d) => (
                <button
                  key={d}
                  onClick={() => load(d)}
                  className="rounded bg-neutral-800 px-4 py-2 hover:bg-neutral-700"
                >
                  💾 {d}
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="mb-2 max-h-56 overflow-y-auto rounded border border-neutral-800">
                {browse.dirs.length === 0 ? (
                  <p className="px-3 py-2 text-neutral-500">No subfolders</p>
                ) : (
                  browse.dirs.map((d) => (
                    <button
                      key={d}
                      onClick={() => load(`${browse.path}\\${d}`)}
                      className="block w-full truncate px-3 py-1.5 text-left hover:bg-neutral-800"
                    >
                      📁 {d}
                    </button>
                  ))
                )}
              </div>
              {showNewFolder ? (
                <div className="mb-2 flex items-center gap-2 rounded border border-neutral-700 bg-neutral-800/50 p-2">
                  <input
                    autoFocus
                    type="text"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") createFolder();
                      else if (e.key === "Escape") setShowNewFolder(false);
                    }}
                    placeholder="New folder name"
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm outline-none focus:border-blue-600"
                  />
                  <Button kind="primary" onClick={createFolder} disabled={!newFolderName.trim()}>
                    Create
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
                <Button kind="primary" onClick={() => onPick(browse.path!)}>
                  Use this folder
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
