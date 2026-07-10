import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Persistent app state lives in one JSON file under %LOCALAPPDATA%\multiclaude\.
 * It holds the browser layout, UI settings, and the recent-folders list —
 * no database, just a config file, like a router's startup-config.
 */

export interface AppState {
  layout: unknown | null;
  settings: {
    fontSize: number;
    scrollback: number;
  };
  recentFolders: string[];
}

const DEFAULT_STATE: AppState = {
  layout: null,
  settings: { fontSize: 14, scrollback: 10000 },
  recentFolders: [],
};

export const dataDir = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "multiclaude"
);
export const imagesDir = path.join(dataDir, "images");
const stateFile = path.join(dataDir, "state.json");

export function readState(): AppState {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      layout: raw.layout ?? null,
      settings: { ...DEFAULT_STATE.settings, ...(raw.settings ?? {}) },
      recentFolders: Array.isArray(raw.recentFolders) ? raw.recentFolders.slice(0, 10) : [],
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

export function writeState(state: AppState): void {
  fs.mkdirSync(dataDir, { recursive: true });
  // Write to a temp file then rename, so a crash mid-write can't corrupt state.
  const tmp = stateFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile);
}

export function rememberFolder(folder: string): void {
  const state = readState();
  state.recentFolders = [folder, ...state.recentFolders.filter((f) => f !== folder)].slice(0, 10);
  writeState(state);
}
