import { useEffect, useMemo, useRef, useState } from "react";

export interface Command {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  danger?: boolean;
  run: () => void;
}

/** Subsequence fuzzy score: higher is better, -1 means no match. */
function score(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const sub = t.indexOf(q);
  if (sub !== -1) return 1000 - sub; // contiguous substring — best, earlier wins
  let ti = 0;
  let gaps = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found === -1) return -1;
    gaps += found - ti;
    ti = found + 1;
  }
  return 500 - gaps; // subsequence — penalise spread-out matches
}

/**
 * Ctrl-K quick switcher: fuzzy-jump to any session or run any action. Built for
 * when you have a lot of panes and don't want to hunt for the tab.
 */
export default function CommandPalette({
  commands,
  onClose,
}: {
  commands: Command[];
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!q.trim()) return commands;
    return commands
      .map((c) => ({ c, s: score(q.trim(), `${c.title} ${c.subtitle ?? ""} ${c.group}`) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }, [q, commands]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    // Keep the highlighted row in view as you arrow through.
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [idx, filtered]);

  const runAt = (i: number) => {
    const cmd = filtered[i];
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(idx);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  // Group headers rendered inline as the list is already sorted by score; when
  // there's no query we show the natural grouping.
  let lastGroup = "";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[70vh] w-[560px] max-w-[95vw] flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Jump to a session or run a command…"
          spellCheck={false}
          className="border-b border-neutral-700 bg-transparent px-4 py-3 text-sm text-neutral-100 outline-none placeholder:text-neutral-500"
        />
        <div ref={listRef} className="overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-neutral-500">No matches</p>
          ) : (
            filtered.map((c, i) => {
              const showGroup = !q.trim() && c.group !== lastGroup;
              lastGroup = c.group;
              return (
                <div key={c.id}>
                  {showGroup && (
                    <p className="px-4 pb-1 pt-2 text-[11px] uppercase tracking-wide text-neutral-500">
                      {c.group}
                    </p>
                  )}
                  <button
                    data-active={i === idx}
                    onMouseMove={() => setIdx(i)}
                    onClick={() => runAt(i)}
                    className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm ${
                      i === idx ? "bg-neutral-700/70" : "hover:bg-neutral-800"
                    }`}
                  >
                    <span className={c.danger ? "text-red-300" : "text-neutral-100"}>{c.title}</span>
                    {c.subtitle && (
                      <span className="truncate font-mono text-xs text-neutral-500">{c.subtitle}</span>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="flex gap-4 border-t border-neutral-800 px-4 py-1.5 text-[11px] text-neutral-500">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
