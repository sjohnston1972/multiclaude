import crypto from "node:crypto";
import { AutonomousManager } from "./manager.js";
import { readRecords, writeRecords } from "./store.js";
import type { AutonomousRecord } from "./types.js";

/**
 * The live registry of autonomous tabs: the managers (owning the claude
 * processes) and their persisted records. Kept in one place so the routes stay
 * thin and Steps 11 (persist) / 12 (relaunch) have a single source of truth.
 */

const managers = new Map<string, AutonomousManager>();
const records = new Map<string, AutonomousRecord>();

/** Test seam: when set, new managers spawn this command+args instead of real `claude`. */
let spawnOverride: { command: string; args: string[] } | null = null;
export function __setSpawnOverride(x: { command: string; args: string[] } | null): void {
  spawnOverride = x;
}

export interface CreateTabInput {
  taskName: string;
  projectDir: string;
  addDirs?: string[];
  model?: string;
  budgetUsd?: number | null;
  extraAllowRules?: string;
  /** Reuse a pinned UUID (relaunch, Step 12). */
  sessionId?: string;
  launchTag?: string | null;
}

/** Write all current records to disk (R9). Called on create and every state change. */
function persist(): void {
  try {
    writeRecords(listTabs());
  } catch {
    /* best-effort — a transient file lock must never crash the server */
  }
}

/**
 * Load persisted records on startup. Their supervisors aren't live yet, so they
 * come back as relaunchable (Step 12 offers a one-click relaunch with the pinned
 * UUID). Records mid-run when the server died are marked so, not shown as running.
 */
export function loadPersisted(): void {
  for (const r of readRecords()) {
    if (records.has(r.id)) continue;
    records.set(r.id, { ...r, state: r.state === "done" || r.state === "blocked" ? r.state : "error" });
  }
}

/** Merge the static record with the manager's live status into the API DTO. */
function dto(id: string): AutonomousRecord | undefined {
  const r = records.get(id);
  if (!r) return undefined;
  const m = managers.get(id);
  if (!m) return { ...r, relaunchable: true };
  const s = m.getStatus();
  return { ...r, state: s.state, currentStep: s.currentStep, costUsd: s.costUsd, lastError: s.lastError, relaunchable: false };
}

export function createTab(input: CreateTabInput): AutonomousRecord {
  const id = crypto.randomUUID().slice(0, 8);
  const manager = new AutonomousManager({
    cwd: input.projectDir,
    model: input.model,
    addDirs: input.addDirs,
    budgetUsd: input.budgetUsd ?? undefined,
    extraAllowRules: input.extraAllowRules,
    sessionId: input.sessionId,
    spawn: spawnOverride ?? undefined,
  });
  const record: AutonomousRecord = {
    id,
    taskName: input.taskName,
    projectDir: input.projectDir,
    addDirs: input.addDirs ?? [],
    model: input.model ?? "sonnet",
    budgetUsd: input.budgetUsd ?? null,
    extraAllowRules: input.extraAllowRules ?? "",
    sessionId: manager.sessionId,
    launchTag: input.launchTag ?? null,
    state: "preflight",
    currentStep: null,
    startedAt: Date.now(),
    lastTurnAt: null,
    costUsd: 0,
    lastError: null,
  };
  managers.set(id, manager);
  records.set(id, record);

  manager.onState((s) => {
    record.state = s;
    record.lastTurnAt = Date.now();
    record.lastError = manager.lastError;
    persist();
  });

  void manager.start();
  record.state = manager.getState();
  persist();
  return dto(id)!;
}

export function listTabs(): AutonomousRecord[] {
  return [...records.keys()].map((id) => dto(id)!).filter(Boolean);
}

/**
 * Relaunch a persisted (or stopped) run, reusing its pinned UUID so the
 * conversation *continues* via --resume rather than restarting (R9). No-op if the
 * supervisor is already live.
 */
export function relaunchTab(id: string): AutonomousRecord | undefined {
  const record = records.get(id);
  if (!record) return undefined;
  const existing = managers.get(id);
  if (existing && (existing.getState() === "running" || existing.getState() === "sleeping")) {
    return dto(id); // already live — nothing to do
  }
  const manager = new AutonomousManager({
    cwd: record.projectDir,
    model: record.model,
    addDirs: record.addDirs,
    budgetUsd: record.budgetUsd ?? undefined,
    extraAllowRules: record.extraAllowRules,
    sessionId: record.sessionId, // reuse the pinned UUID → --resume continues the conversation
    startResumed: true,
    spawn: spawnOverride ?? undefined,
  });
  managers.set(id, manager);
  manager.onState((s) => {
    record.state = s;
    record.lastTurnAt = Date.now();
    record.lastError = manager.lastError;
    persist();
  });
  void manager.start();
  record.state = manager.getState();
  persist();
  return dto(id);
}

export function getTab(id: string): AutonomousRecord | undefined {
  return dto(id);
}

export function getManager(id: string): AutonomousManager | undefined {
  return managers.get(id);
}

/** Stop and forget everything — used by tests between cases. */
export function __resetForTests(): void {
  for (const m of managers.values()) m.stop();
  managers.clear();
  records.clear();
  spawnOverride = null;
}
