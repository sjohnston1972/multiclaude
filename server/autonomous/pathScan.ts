import path from "node:path";

/**
 * Pre-flight check 5 (R6.5, fixes B3/B4): scan PLAN.md for filesystem paths and
 * flag anything the sandbox can't reach — a `..` traversal, an absolute path
 * outside the repo, or an unresolved environment variable — resolving each
 * against the configured --add-dir list. This is the exact class of problem that
 * blocked the 2026-07-13 run (a sibling-repo path discovered at runtime).
 */

export type PathIssue = "traversal" | "outside-repo" | "unresolved-env" | null;

export interface PathScanRow {
  /** The path token as it appears in PLAN.md. */
  path: string;
  /** Absolute resolution, or null when an env var couldn't be resolved. */
  resolvesTo: string | null;
  /** Within the repo root or an --add-dir? */
  reachable: boolean;
  issue: PathIssue;
}

const ENV_RE = /\$\{?\w+\}?|%\w+%/;

/** Case-insensitive (Windows) containment: is `child` inside `parent`? */
function isInside(child: string, parent: string): boolean {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  const pSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c === p || c.startsWith(pSep);
}

/** Expand $VAR / ${VAR} / %VAR%. Returns null if any referenced var is undefined. */
function expandEnv(s: string): string | null {
  let unresolved = false;
  const out = s.replace(/\$\{(\w+)\}|\$(\w+)|%(\w+)%/g, (_m, a, b, c) => {
    const name = a ?? b ?? c;
    const val = process.env[name];
    if (val === undefined) {
      unresolved = true;
      return "";
    }
    return val;
  });
  return unresolved ? null : out;
}

function looksLikePath(s: string): boolean {
  if (!/[\\/]/.test(s)) return false;
  // Note: a leading single "/" (e.g. "/api/hello") is a URL route or POSIX example,
  // not a Windows filesystem path — deliberately NOT treated as a path here, to
  // avoid noisy false "outside-repo" flags on API endpoints in the plan text.
  return (
    /^\.\.[\\/]/.test(s) || // ../…
    /^[A-Za-z]:[\\/]/.test(s) || // C:\ or C:/
    ENV_RE.test(s) || // has an env var
    /^[\w.-]+[\\/]/.test(s) // relative like server/foo.ts
  );
}

/** Collect candidate path tokens: backtick code spans plus bare absolute/traversal/env paths. */
function candidatePaths(planText: string): string[] {
  const set = new Set<string>();
  for (const m of planText.matchAll(/`([^`]+)`/g)) {
    const t = m[1].trim();
    if (looksLikePath(t)) set.add(t);
  }
  for (const m of planText.matchAll(/(?:\.\.[\\/]|[A-Za-z]:[\\/]|\$\{?\w+\}?[\\/]|%\w+%[\\/])[^\s`)"']+/g)) {
    set.add(m[0]);
  }
  return [...set];
}

export function scanPlanForPaths(planText: string, repoRoot: string, addDirs: string[] = []): PathScanRow[] {
  return candidatePaths(planText).map((raw) => {
    // Unresolved env var → can't even resolve it; flag and stop.
    if (ENV_RE.test(raw)) {
      const expanded = expandEnv(raw);
      if (expanded === null) {
        return { path: raw, resolvesTo: null, reachable: false, issue: "unresolved-env" };
      }
      raw = expanded; // fall through with the resolved string (keep displaying the resolved form)
    }

    const isAbsolute = /^[A-Za-z]:[\\/]/.test(raw); // Windows drive paths only (see looksLikePath)
    const resolvesTo = isAbsolute ? path.resolve(raw) : path.resolve(repoRoot, raw);
    const reachable = isInside(resolvesTo, repoRoot) || addDirs.some((d) => isInside(resolvesTo, d));

    let issue: PathIssue = null;
    if (raw.startsWith("..")) issue = "traversal";
    else if (isAbsolute && !reachable) issue = "outside-repo";
    else if (!reachable) issue = "outside-repo";

    return { path: raw, resolvesTo, reachable, issue };
  });
}
