import { useEffect, useState } from "react";
import { api, SessionInfo } from "./api";
import { Button, Modal } from "./components";

/**
 * Shows every live session the server holds — attached to a tab or running
 * in the background — with reattach and kill actions.
 */
export default function SessionListModal({
  openSessionIds,
  onReattach,
  onKill,
  onClose,
}: {
  openSessionIds: Set<string>;
  onReattach: (s: SessionInfo) => void;
  onKill: (s: SessionInfo) => Promise<void>;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    api<SessionInfo[]>("/api/sessions")
      .then(setSessions)
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <Modal title="Live sessions" onClose={onClose} wide>
      {error && <p className="mb-2 text-red-400">{error}</p>}
      {sessions === null ? (
        <p className="text-neutral-400">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="text-neutral-400">No sessions running.</p>
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr className="text-xs uppercase text-neutral-500">
              <th className="pb-2">Session</th>
              <th className="pb-2">Folder</th>
              <th className="pb-2">Status</th>
              <th className="pb-2"></th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} className="border-t border-neutral-800">
                <td className="py-2 pr-3 font-medium">{s.title}</td>
                <td className="max-w-[220px] truncate py-2 pr-3 text-neutral-400" title={s.cwd}>
                  {s.cwd}
                </td>
                <td className="py-2 pr-3">
                  {openSessionIds.has(s.id) ? (
                    <span className="text-blue-400">in a tab</span>
                  ) : (
                    <span className="text-amber-400">background</span>
                  )}
                </td>
                <td className="py-2 text-right">
                  <span className="inline-flex gap-2">
                    {!openSessionIds.has(s.id) && (
                      <Button kind="primary" onClick={() => onReattach(s)}>
                        Reattach
                      </Button>
                    )}
                    <Button
                      kind="danger"
                      onClick={() => {
                        // Optimistic: drop the row now; the server confirms in ~1s.
                        setSessions((prev) => prev?.filter((x) => x.id !== s.id) ?? prev);
                        void onKill(s).then(refresh);
                      }}
                    >
                      Kill
                    </Button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
