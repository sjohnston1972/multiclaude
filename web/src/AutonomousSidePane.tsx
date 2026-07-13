import { useEffect, useState } from "react";

/**
 * R4 side pane: live PROGRESS.md and read-only PLAN.md (current step highlighted).
 * A populated `## Blockers` section raises a prominent banner — the single most
 * important signal in the feature. Polls the files endpoint every 2s; no markdown
 * dependency, so content renders as monospace text.
 */

interface Files {
  plan: string | null;
  progress: string | null;
  blockersPresent: boolean;
}

/** The leading step number, e.g. "Step 3/10: …" → 3. */
function stepNumber(currentStep: string | null): number | null {
  const m = currentStep?.match(/Step\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

export default function AutonomousSidePane({
  tabId,
  currentStep,
}: {
  tabId: string;
  currentStep: string | null;
}) {
  const [files, setFiles] = useState<Files | null>(null);
  const [view, setView] = useState<"progress" | "plan">("progress");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/autonomous/${encodeURIComponent(tabId)}/files`);
        if (res.ok && alive) setFiles(await res.json());
      } catch {
        /* server briefly unreachable — next poll retries */
      }
    };
    void load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tabId]);

  const n = stepNumber(currentStep);
  const planLines = (files?.plan ?? "").split(/\r?\n/);

  return (
    <div className="flex w-96 shrink-0 flex-col border-l border-neutral-800 bg-neutral-900 text-xs">
      {files?.blockersPresent && (
        <button
          onClick={() => setView("progress")}
          className="border-b border-amber-500 bg-amber-500/20 px-3 py-2 text-left font-semibold text-amber-300"
        >
          ⚠️ Blockers — this run stopped on an ambiguity. See PROGRESS.md.
        </button>
      )}
      <div className="flex border-b border-neutral-800">
        {(["progress", "plan"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`px-3 py-1.5 ${view === v ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"}`}
          >
            {v === "progress" ? "PROGRESS.md" : "PLAN.md"}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 font-mono leading-relaxed">
        {view === "progress" ? (
          files?.progress == null ? (
            <div className="text-neutral-500">No PROGRESS.md found.</div>
          ) : (
            <pre className="whitespace-pre-wrap break-words text-neutral-200">{files.progress}</pre>
          )
        ) : files?.plan == null ? (
          <div className="text-neutral-500">No PLAN.md found.</div>
        ) : (
          <div className="whitespace-pre-wrap break-words">
            {planLines.map((line, i) => {
              const isCurrent = n != null && new RegExp(`^\\s*${n}\\.`).test(line);
              return (
                <div key={i} className={isCurrent ? "-mx-1 rounded bg-blue-600/25 px-1 text-blue-100" : "text-neutral-300"}>
                  {line || " "}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
