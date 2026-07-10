import { Button, Modal } from "./components";

export interface RestorableSpec {
  id: string;
  cwd: string;
  title: string;
}

/**
 * Shown on load when the server was restarted (or the machine rebooted) and
 * there are sessions from last time that aren't running now. Restoring
 * respawns them in the same folders, re-running whatever they auto-started
 * (e.g. claude) — the running program itself can't survive a restart, but you
 * land back in the same workspace instead of rebuilding it by hand.
 */
export default function RestoreModal({
  specs,
  busy,
  onRestore,
  onStartFresh,
}: {
  specs: RestorableSpec[];
  busy: boolean;
  onRestore: () => void;
  onStartFresh: () => void;
}) {
  return (
    <Modal title="Restore your sessions?" onClose={onStartFresh} wide>
      <p className="mb-3 text-neutral-300">
        multiclaude was restarted. {specs.length} session{specs.length === 1 ? "" : "s"} from last
        time {specs.length === 1 ? "isn't" : "aren't"} running. Bring{" "}
        {specs.length === 1 ? "it" : "them"} back in the same folders?
      </p>
      <div className="mb-4 max-h-56 overflow-y-auto rounded border border-neutral-800">
        {specs.map((s) => (
          <div
            key={s.id}
            className="flex items-center justify-between gap-3 border-b border-neutral-800 px-3 py-1.5 text-sm last:border-b-0"
          >
            <span className="font-medium text-neutral-100">{s.title}</span>
            <span className="truncate font-mono text-xs text-neutral-500" title={s.cwd}>
              {s.cwd}
            </span>
          </div>
        ))}
      </div>
      <p className="mb-4 text-xs text-neutral-500">
        The programs that were running can't be brought back to life — restoring reopens the shells
        in those folders and re-runs anything they auto-started.
      </p>
      <div className="flex justify-end gap-2">
        <Button onClick={onStartFresh} disabled={busy}>
          Start fresh
        </Button>
        <Button kind="primary" onClick={onRestore} disabled={busy}>
          {busy ? "Restoring…" : `Restore ${specs.length} session${specs.length === 1 ? "" : "s"}`}
        </Button>
      </div>
    </Modal>
  );
}
