import type { ReactNode } from "react";

/**
 * Minimal, dependency-free markdown for the side pane (the fixed tech stack has no
 * markdown lib). Handles headings, **bold**, `inline code`, and bullet / numbered
 * lists — enough to make PROGRESS.md and PLAN.md read cleanly. Not full CommonMark.
 * `highlightNum` highlights the ordered-list item with that leading number (the
 * current step in PLAN.md).
 */

/** Parse **bold** and `code` spans within one line into React nodes. */
function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      nodes.push(
        <strong key={`${keyBase}-${i}`} className="text-neutral-100">
          {tok.slice(2, -2)}
        </strong>
      );
    } else {
      nodes.push(
        <code key={`${keyBase}-${i}`} className="rounded bg-neutral-800 px-1 text-[11px] text-emerald-300">
          {tok.slice(1, -1)}
        </code>
      );
    }
    last = m.index + tok.length;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export default function Markdown({ text, highlightNum }: { text: string; highlightNum?: number | null }) {
  const out: ReactNode[] = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    const key = `l${idx}`;

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const cls =
        level === 1
          ? "mt-2 mb-1 text-sm font-semibold text-neutral-100"
          : level === 2
            ? "mt-2 mb-0.5 text-xs font-semibold text-neutral-200"
            : "mt-1 text-xs font-medium text-neutral-300";
      out.push(
        <div key={key} className={cls}>
          {inline(heading[2], key)}
        </div>
      );
      return;
    }

    const ordered = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (ordered) {
      const num = Number(ordered[1]);
      const hl = highlightNum != null && num === highlightNum;
      out.push(
        <div key={key} className={"flex gap-1.5 " + (hl ? "-mx-1 rounded bg-blue-600/25 px-1 text-blue-100" : "text-neutral-300")}>
          <span className="shrink-0 text-neutral-500">{num}.</span>
          <span>{inline(ordered[2], key)}</span>
        </div>
      );
      return;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      out.push(
        <div key={key} className="flex gap-1.5 text-neutral-300">
          <span className="shrink-0 text-neutral-500">•</span>
          <span>{inline(bullet[1], key)}</span>
        </div>
      );
      return;
    }

    if (line.trim() === "") {
      out.push(<div key={key} className="h-2" />);
      return;
    }
    out.push(
      <div key={key} className="text-neutral-300">
        {inline(line, key)}
      </div>
    );
  });

  return <div className="space-y-0.5 leading-relaxed">{out}</div>;
}
