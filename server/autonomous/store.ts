import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../stateStore.js";
import type { AutonomousRecord } from "./types.js";

/**
 * Persist autonomous tab records (R9) to %LOCALAPPDATA%\multiclaude\autonomous.json,
 * using the same atomic tmp-write-then-rename as the rest of the app's state so a
 * crash mid-write can't corrupt it. The path is env-overridable so tests never
 * touch the real file.
 */

function recordsFile(): string {
  return process.env.MULTICLAUDE_AUTONOMOUS_FILE ?? path.join(dataDir, "autonomous.json");
}

export function readRecords(): AutonomousRecord[] {
  try {
    const raw = JSON.parse(fs.readFileSync(recordsFile(), "utf8"));
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.id === "string" && typeof r.sessionId === "string") : [];
  } catch {
    return [];
  }
}

export function writeRecords(records: AutonomousRecord[]): void {
  const file = recordsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
  fs.renameSync(tmp, file);
}
