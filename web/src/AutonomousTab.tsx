import { useEffect, useMemo, useRef, useState } from "react";
import type { TabNode } from "flexlayout-react";
import AutonomousSidePane from "./AutonomousSidePane";

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
  cacheHitPct: number | null;
  turnElapsedMs: number;
  totalElapsedMs: number;
  wakeAt: number | null;
  lastError: string | null;
}

const STATE_STYLE: Record<string, { label: string; cls: string }> = {
  preflight: { label: "preflight", cls: "bg-neutral-700 text-neutral-200" },
  running: { label: "running", cls: "bg-blue-600 text-white" },
  sleeping: { label: "sleeping", cls: "bg-amber-600 text-white" },
  paused: { label: "paused", cls: "bg-neutral-500 text-white" },
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
  const [showFiles, setShowFiles] = useState(true);
  const [copied, setCopied] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [busy, setBusy] = useState(false);
  // Ticking clock so elapsed times advance between status messages.
  const [, setTick] = useState(0);
  const statusRef = useRef<{ s: Status; at: number } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    // Reconnect on drop (server restart, relaunch of a dead run) — replay resets
    // the event list, so reconnecting never duplicates. Like TerminalPane.
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws/autonomous?tab=${encodeURIComponent(tabId)}`);
      setConn("connecting");
      ws.onopen = () => setConn("open");
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
      ws.onclose = () => {
        setConn("closed");
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
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
  // Only advance the clocks while actually running — freeze them once the run ends.
  const totalElapsed = (status?.totalElapsedMs ?? 0) + (running && live ? sinceStatus : 0);
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

  const control = async (action: "pause" | "resume" | "kill" | "rollback") => {
    setBusy(true);
    try {
      await fetch(`/api/autonomous/${encodeURIComponent(tabId)}/${action}`, { method: "POST" });
    } catch {
      /* status stream reflects the result */
    } finally {
      setBusy(false);
    }
  };

  const st = status?.state;
  const rollbackCmd = `git reset --hard <launch-tag> && git clean -fd`;

  // A loud, unmistakable banner for any non-running resting state.
  const completion =
    st === "done"
      ? { cls: "border-emerald-700 bg-emerald-950/50 text-emerald-200", text: "✓ Task complete — every PLAN.md step is done and verified. Nothing else will run." }
      : st === "blocked"
        ? { cls: "border-amber-600 bg-amber-950/50 text-amber-200", text: "⚠ Stopped on a blocker — read the Blockers section in PROGRESS.md (right), then Resume or Rollback." }
        : st === "error"
          ? { cls: "border-red-800 bg-red-950/60 text-red-200", text: `✗ Stopped with an error${status?.lastError ? ": " + status.lastError : ""}.` }
          : st === "paused"
            ? { cls: "border-neutral-600 bg-neutral-800/60 text-neutral-200", text: "⏸ Paused — click Resume to continue where it left off." }
            : st === "sleeping"
              ? { cls: "border-amber-700 bg-amber-950/40 text-amber-200", text: "⏳ Sleeping until the usage limit resets — it will resume automatically." }
              : null;

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
        {status?.cacheHitPct != null && (
          <span className="text-neutral-500" title="Share of input tokens served from the prompt cache — higher means cheaper resumes">
            cache {status.cacheHitPct}%
          </span>
        )}
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
        <button onClick={() => setShowFiles((v) => !v)} className="text-neutral-500 hover:text-neutral-300">
          {showFiles ? "Hide files" : "Show files"}
        </button>
      </div>

      {/* R5 — controls */}
      <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-1.5">
        {st === "running" || st === "sleeping" ? (
          <button disabled={busy} onClick={() => control("pause")} className="rounded bg-neutral-700 px-2 py-0.5 text-xs text-neutral-100 hover:bg-neutral-600 disabled:opacity-50">
            Pause
          </button>
        ) : (
          <button disabled={busy} onClick={() => control("resume")} className="rounded bg-blue-600 px-2 py-0.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50">
            Resume
          </button>
        )}
        <button disabled={busy} onClick={() => control("kill")} className="rounded bg-neutral-700 px-2 py-0.5 text-xs text-neutral-100 hover:bg-neutral-600 disabled:opacity-50">
          Kill
        </button>
        <button disabled={busy} onClick={() => setConfirmRollback(true)} className="rounded bg-red-800 px-2 py-0.5 text-xs text-white hover:bg-red-700 disabled:opacity-50">
          Rollback
        </button>
      </div>

      {completion && <div className={"border-b px-3 py-1.5 text-xs font-medium " + completion.cls}>{completion.text}</div>}

      {confirmRollback && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={() => setConfirmRollback(false)}>
          <div className="w-[520px] max-w-[95vw] rounded-lg border border-red-800 bg-neutral-900 p-4 text-sm" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="mb-2 font-semibold text-red-300">Roll back this run?</h3>
            <p className="mb-2 text-neutral-300">This discards all work since launch and removes the run's state directory. It runs, in the project repo:</p>
            <pre className="mb-3 overflow-x-auto rounded bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-200">{rollbackCmd}</pre>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmRollback(false)} className="rounded bg-neutral-700 px-3 py-1 text-neutral-100 hover:bg-neutral-600">
                Cancel
              </button>
              <button
                onClick={() => {
                  setConfirmRollback(false);
                  void control("rollback");
                }}
                className="rounded bg-red-700 px-3 py-1 text-white hover:bg-red-600"
              >
                Yes, reset --hard
              </button>
            </div>
          </div>
        </div>
      )}

      {status?.lastError && (
        <div className="border-b border-red-900 bg-red-950/60 px-3 py-1.5 text-xs text-red-200">{status.lastError}</div>
      )}

      {/* R3 event log + R4 side pane */}
      <div className="flex min-h-0 flex-1">
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
        {showFiles && <AutonomousSidePane tabId={tabId} currentStep={status?.currentStep ?? null} />}
      </div>
    </div>
  );
}
