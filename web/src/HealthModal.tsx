import { useEffect, useState } from "react";
import { api, SessionInfo } from "./api";
import { Modal } from "./components";

interface Health {
  ok: boolean;
  shell: string;
  pid: number;
  uptimeSeconds: number;
  sessions: SessionInfo[];
}

function fmtUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function HealthModal({ onClose }: { onClose: () => void }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () =>
      api<Health>("/api/health")
        .then((h) => {
          setHealth(h);
          setError(null);
        })
        .catch((e) => setError(e.message));
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <Modal title="Health" onClose={onClose} wide>
      {error && <p className="mb-2 text-red-400">{error}</p>}
      {health && (
        <>
          <div className="mb-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded bg-neutral-800 p-2">
              <p className="text-xs text-neutral-500">Shell</p>
              <p className="font-medium">{health.shell}</p>
            </div>
            <div className="rounded bg-neutral-800 p-2">
              <p className="text-xs text-neutral-500">Server PID</p>
              <p className="font-medium">{health.pid}</p>
            </div>
            <div className="rounded bg-neutral-800 p-2">
              <p className="text-xs text-neutral-500">Server uptime</p>
              <p className="font-medium">{fmtUptime(health.uptimeSeconds)}</p>
            </div>
          </div>
          {health.sessions.length === 0 ? (
            <p className="text-neutral-400">No sessions running.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase text-neutral-500">
                  <th className="pb-1">Session</th>
                  <th className="pb-1">PID</th>
                  <th className="pb-1">Working dir</th>
                  <th className="pb-1">Uptime</th>
                  <th className="pb-1">Attached</th>
                </tr>
              </thead>
              <tbody>
                {health.sessions.map((s) => (
                  <tr key={s.id} className="border-t border-neutral-800">
                    <td className="py-1.5 pr-2 font-medium">{s.title}</td>
                    <td className="py-1.5 pr-2">{s.pid}</td>
                    <td className="max-w-[200px] truncate py-1.5 pr-2 text-neutral-400" title={s.cwd}>
                      {s.cwd}
                    </td>
                    <td className="py-1.5 pr-2">
                      {fmtUptime((Date.now() - s.createdAt) / 1000)}
                    </td>
                    <td className="py-1.5">{s.attached ? "yes" : "background"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Modal>
  );
}
