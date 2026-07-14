import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../stateStore.js";

/**
 * Remembers the additional directories (--add-dir grants) a user chose per project,
 * so a repo like clarion that always needs a sibling repo doesn't have to be
 * re-granted every launch. Keyed by the resolved project dir; env-overridable path
 * so tests don't touch real app state.
 */

function file(): string {
  return process.env.MULTICLAUDE_ADDDIRS_FILE ?? path.join(dataDir, "autonomous-adddirs.json");
}

function readAll(): Record<string, string[]> {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

const key = (projectDir: string): string => path.resolve(projectDir).toLowerCase();

export function readAddDirs(projectDir: string): string[] {
  const v = readAll()[key(projectDir)];
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

export function writeAddDirs(projectDir: string, dirs: string[]): void {
  const all = readAll();
  const clean = [...new Set(dirs.map((d) => d.trim()).filter(Boolean))];
  if (clean.length) all[key(projectDir)] = clean;
  else delete all[key(projectDir)];
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, f);
}
