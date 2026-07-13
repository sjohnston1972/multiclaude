import { useEffect, useState } from "react";
import { Modal } from "./components";
import FolderPickerModal from "./FolderPickerModal";
import AutonomousOnboarding, { hasOnboarded } from "./AutonomousOnboarding";

/**
 * The Autonomous new-tab launcher (R1): project dir, task name, additional dirs,
 * model, budget cap, extra Bash allow-rules — and an embedded pre-flight panel
 * (R6) that gates Launch. There is deliberately NO "max turns" field: it doesn't
 * exist in the CLI; the one-step bound comes from the prompt + discipline.
 */

interface Check {
  id: string;
  label: string;
  level: "ok" | "warn" | "fail";
  detail: string;
}
interface PathRow {
  path: string;
  resolvesTo: string | null;
  reachable: boolean;
  issue: string | null;
}
interface Preflight {
  checks: Check[];
  seedable: boolean;
  disciplineOfferAppend: boolean;
  pathScan: PathRow[];
  canLaunch: boolean;
}

const ICON = { ok: "✅", warn: "⚠️", fail: "❌" } as const;

export interface LaunchedTab {
  id: string;
  taskName: string;
}

export default function AutonomousNewDialog({
  onLaunched,
  onClose,
}: {
  onLaunched: (t: LaunchedTab) => void;
  onClose: () => void;
}) {
  const [projectDir, setProjectDir] = useState("");
  const [taskName, setTaskName] = useState("");
  const [addDirsText, setAddDirsText] = useState("");
  const [model, setModel] = useState("sonnet");
  const [budget, setBudget] = useState("");
  const [extraAllow, setExtraAllow] = useState("");
  const [seedProgress, setSeedProgress] = useState(true);
  const [pf, setPf] = useState<Preflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [browsing, setBrowsing] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(!hasOnboarded());

  const addDirs = () =>
    addDirsText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  // Re-run pre-flight whenever the project dir or additional dirs change.
  useEffect(() => {
    if (!projectDir.trim()) {
      setPf(null);
      return;
    }
    let alive = true;
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/autonomous/preflight", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectDir: projectDir.trim(), addDirs: addDirs() }),
        });
        const body = await res.json();
        if (alive) setPf(res.ok ? body : null);
      } catch {
        if (alive) setPf(null);
      } finally {
        if (alive) setChecking(false);
      }
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir, addDirsText]);

  const warnIds = (pf?.checks ?? []).filter((c) => c.level === "warn").map((c) => c.id);
  const allWarnsAccepted = warnIds.every((id) => accepted[id]);
  const taskOk = /^[a-z0-9][a-z0-9-]*$/.test(taskName);
  const canLaunch = !!pf?.canLaunch && allWarnsAccepted && taskOk && !launching;

  const launch = async () => {
    setLaunching(true);
    setError(null);
    try {
      const res = await fetch("/api/autonomous/launch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskName: taskName.trim(),
          projectDir: projectDir.trim(),
          addDirs: addDirs(),
          model,
          budgetUsd: budget.trim() ? Number(budget) : null,
          extraAllowRules: extraAllow.trim(),
          seedProgress,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Launch failed");
        setLaunching(false);
        return;
      }
      onLaunched({ id: body.id, taskName: body.taskName });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setLaunching(false);
    }
  };

  return (
    <Modal title="New autonomous run" onClose={onClose} wide>
      {showHelp && <AutonomousOnboarding onClose={() => setShowHelp(false)} />}

      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-neutral-400">Hand a task to a resumable, observable Claude run.</span>
          <button onClick={() => setShowHelp(true)} className="text-neutral-500 hover:text-neutral-300" title="How autonomous runs work">
            ⍰ Help
          </button>
        </div>

        <label className="block">
          <span className="text-neutral-300">Project directory (a git repo)</span>
          <div className="mt-1 flex gap-2">
            <input value={projectDir} onChange={(e) => setProjectDir(e.target.value)} placeholder="C:\path\to\repo" className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-neutral-100" />
            <button onClick={() => setBrowsing(true)} className="rounded bg-neutral-700 px-3 text-neutral-100 hover:bg-neutral-600">
              Browse…
            </button>
          </div>
        </label>

        <label className="block">
          <span className="text-neutral-300">Task name (kebab-case — becomes the state-dir name)</span>
          <input value={taskName} onChange={(e) => setTaskName(e.target.value)} placeholder="my-feature" className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-neutral-100" />
          {taskName && !taskOk && <span className="text-xs text-red-400">Only lowercase letters, numbers, and dashes.</span>}
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-neutral-300">Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-neutral-100">
              <option value="sonnet">sonnet</option>
              <option value="opus">opus</option>
            </select>
          </label>
          <label className="block">
            <span className="text-neutral-300">Budget cap USD (optional)</span>
            <input value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="e.g. 5" inputMode="decimal" className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-neutral-100" />
          </label>
        </div>

        <label className="block">
          <span className="text-neutral-300">Additional directories (one per line — each becomes --add-dir)</span>
          <textarea value={addDirsText} onChange={(e) => setAddDirsText(e.target.value)} rows={2} className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-100" />
        </label>

        <label className="block">
          <span className="text-neutral-300">Extra Bash allow-rules (optional — widens the default git/npm/npx/node scope)</span>
          <input value={extraAllow} onChange={(e) => setExtraAllow(e.target.value)} placeholder="Bash(pytest *) Bash(cargo *)" className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-100" />
        </label>

        {/* Pre-flight panel (R6) */}
        <div className="rounded border border-neutral-700 bg-neutral-950 p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-semibold text-neutral-200">Pre-flight</span>
            {checking && <span className="text-xs text-neutral-500">checking…</span>}
          </div>
          {!pf ? (
            <p className="text-xs text-neutral-500">Enter a project directory to run pre-flight checks.</p>
          ) : (
            <div className="space-y-1">
              {pf.checks.map((c) => (
                <div key={c.id} className="flex items-start gap-2 text-xs">
                  <span>{ICON[c.level]}</span>
                  <span className="text-neutral-300">
                    <span className="text-neutral-100">{c.label}</span> — {c.detail}
                  </span>
                  {c.level === "warn" && (
                    <label className="ml-auto flex shrink-0 items-center gap-1 text-amber-300">
                      <input type="checkbox" checked={!!accepted[c.id]} onChange={(e) => setAccepted((a) => ({ ...a, [c.id]: e.target.checked }))} />
                      I accept this risk
                    </label>
                  )}
                </div>
              ))}
              {pf.pathScan.length > 0 && (
                <div className="mt-2 border-t border-neutral-800 pt-2">
                  <div className="mb-1 text-xs text-neutral-400">PLAN.md paths</div>
                  <table className="w-full text-[11px]">
                    <tbody>
                      {pf.pathScan.map((r, i) => (
                        <tr key={i} className={r.reachable ? "text-neutral-400" : "text-amber-300"}>
                          <td className="pr-2 font-mono">{r.path}</td>
                          <td className="pr-2">{r.reachable ? "reachable" : (r.issue ?? "unreachable")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {pf.seedable && (
                <label className="mt-1 flex items-center gap-1 text-xs text-neutral-300">
                  <input type="checkbox" checked={seedProgress} onChange={(e) => setSeedProgress(e.target.checked)} />
                  Seed PROGRESS.md and commit it before launch
                </label>
              )}
            </div>
          )}
        </div>

        {error && <p className="rounded bg-red-950 px-3 py-1.5 text-red-300">{error}</p>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded bg-neutral-700 px-3 py-1 text-neutral-100 hover:bg-neutral-600">
            Cancel
          </button>
          <button
            onClick={() => void launch()}
            disabled={!canLaunch}
            title={!pf?.canLaunch ? "Resolve the ❌ checks first" : !allWarnsAccepted ? "Accept the ⚠️ risks first" : ""}
            className="rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {launching ? "Launching…" : "Launch"}
          </button>
        </div>
      </div>

      {browsing && (
        <FolderPickerModal
          title="Pick the project directory"
          onClose={() => setBrowsing(false)}
          onPick={(folder) => {
            setProjectDir(folder);
            if (!taskName) setTaskName(folder.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase().replace(/[^a-z0-9-]+/g, "-") ?? "");
            setBrowsing(false);
          }}
        />
      )}
    </Modal>
  );
}
