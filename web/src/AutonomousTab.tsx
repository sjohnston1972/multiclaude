import { useEffect, useMemo, useRef, useState } from "react";
import type { TabNode } from "flexlayout-react";

/**
 * One Autonomous tab = one WebSocket to /ws/autonomous?tab=<id>. The server holds
 * the run and parses claude's output into render-ready events; this component is a
 * dumb viewer, like TerminalPane. R2 status strip on top, R3 event log below.
 */

interface RenderedLine {
  icon: string;
  summary: string;
}
interface AutoEvent {
  seq: number;
  kind: string;
  payload: unknown;
  rendered: RenderedLine[];
  at: number;
}
interface Status {
  state: string;
  sessionId: string;
  currentStep: string | null;
  lastCommit: { sha: string; subject: string } | null;
  costUsd: number;
  turnElapsedMs: number;
  totalElapsedMs: number;
  wakeAt: number | null;
  lastError: string | null;
}

const STATE_STYLE: Record<string, { label: string; cls: string }> = {
  preflight: { label: "preflight", cls: "bg-neutral-700 text-neutral-200" },
  running: { label: "running", cls: "bg-blue-600 text-white" },
  sleeping: { label: "sleeping", cls: "bg-amber-600 text-white" },
  blocked: { label: "blocked", cls: "bg-orange-600 text-white" },
  done: { label: "DONE", cls: "bg-emerald-600 text-white" },
  error: { label: "error", cls: "bg-red-700 text-white" },
};

function fmtDuration(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function AutonomousTab({
  tabId,
  taskName,
}: {
  tabId: string;
  taskName?: string;
  node?: TabNode;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [events, setEvents] = useState<AutoEvent[]>([]);
  const [conn, setConn] = useState<"connecting" | "open" | "closed">("connecting");
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  // Ticking clock so elapsed times advance between status messages.
  const [, setTick] = useState(0);
  const statusRef = useRef<{ s: Status; at: number } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/autonomous?tab=${encodeURIComponent(tabId)}`);
    ws.onopen = () => setConn("open");
    ws.onclose = () => setConn("closed");
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string);
      if (msg.type === "replay") {
        setEvents(msg.events ?? []);
        setStatus(msg.status ?? null);
        statusRef.current = msg.status ? { s: msg.status, at: Date.now() } : null;
      } else if (msg.type === "event") {
        setEvents((prev) => [...prev, msg.event]);
      } else if (msg.type === "status") {
        setStatus(msg.status);
        statusRef.current = { s: msg.status, at: Date.now() };
      }
    };
    return () => ws.close();
  }, [tabId]);

  // 1s tick for the live elapsed clocks.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Auto-scroll the log to the bottom as lines arrive.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, showRaw]);

  const lines = useMemo(
    () =>
      events.flatMap((ev) =>
        ev.rendered.map((r, i) => ({ key: `${ev.seq}-${i}`, ...r }))
      ),
    [events]
  );

  // Live elapsed: last known status value plus wall-clock since it arrived (while running).
  const live = statusRef.current;
  const running = status?.state === "running";
  const sinceStatus = live ? Date.now() - live.at : 0;
  const totalElapsed = (status?.totalElapsedMs ?? 0) + (live ? sinceStatus : 0);
  const turnElapsed = running ? (status?.turnElapsedMs ?? 0) + sinceStatus : status?.turnElapsedMs ?? 0;

  const badge = STATE_STYLE[status?.state ?? "preflight"] ?? STATE_STYLE.preflight;
  const sleepLabel =
    status?.state === "sleeping" && status.wakeAt
      ? `sleeping (until ${new Date(status.wakeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`
      : badge.label;

  const copyUuid = () => {
    if (!status?.sessionId) return;
    navigator.clipboard?.writeText(status.sessionId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-200">
      {/* R2 — status strip */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-neutral-800 px-3 py-2 text-xs">
        <span className="font-semibold text-neutral-100">{taskName ?? "autonomous"}</span>
        <span className={`rounded px-2 py-0.5 font-medium ${badge.cls}`}>{sleepLabel}</span>
        {status?.currentStep && <span className="text-neutral-300">{status.currentStep}</span>}
        <span className="text-neutral-500">turn {fmtDuration(turnElapsed)}</span>
        <span className="text-neutral-500">total {fmtDuration(totalElapsed)}</span>
        {status?.lastCommit && (
          <span className="text-neutral-400" title={status.lastCommit.subject}>
            <span className="font-mono text-neutral-300">{status.lastCommit.sha}</span>{" "}
            {status.lastCommit.subject.slice(0, 40)}
          </span>
        )}
        <span className="text-emerald-400">${status?.costUsd?.toFixed(2) ?? "0.00"}</span>
        <button
          onClick={copyUuid}
          title="Copy session UUID"
          className="ml-auto font-mono text-[10px] text-neutral-500 hover:text-neutral-300"
        >
          {copied ? "copied!" : (status?.sessionId ?? "").slice(0, 8)}
        </button>
        <label className="flex items-center gap-1 text-neutral-500">
          <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
          Show raw log
        </label>
      </div>

      {status?.lastError && (
        <div className="border-b border-red-900 bg-red-950/60 px-3 py-1.5 text-xs text-red-200">{status.lastError}</div>
      )}

      {/* R3 — event log */}
      <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[13px] leading-relaxed">
        {conn === "connecting" && <div className="text-neutral-500">Connecting…</div>}
        {conn === "closed" && <div className="text-neutral-500">Disconnected — the run may have ended.</div>}
        {showRaw
          ? events.map((ev) => (
              <div key={ev.seq} className="whitespace-pre-wrap break-all text-neutral-400">
                {JSON.stringify(ev.payload)}
              </div>
            ))
          : lines.map((l) => (
              <div key={l.key} className="flex gap-2">
                <span className="w-5 shrink-0 text-center">{l.icon}</span>
                <span className="text-neutral-200">{l.summary}</span>
              </div>
            ))}
      </div>
    </div>
  );
}
