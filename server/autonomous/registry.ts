import crypto from "node:crypto";
import { AutonomousManager } from "./manager.js";
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

/** Merge the static record with the manager's live status into the API DTO. */
function dto(id: string): AutonomousRecord | undefined {
  const r = records.get(id);
  if (!r) return undefined;
  const m = managers.get(id);
  if (!m) return { ...r };
  const s = m.getStatus();
  return { ...r, state: s.state, currentStep: s.currentStep, costUsd: s.costUsd, lastError: s.lastError };
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
  });

  void manager.start();
  record.state = manager.getState();
  return dto(id)!;
}

export function listTabs(): AutonomousRecord[] {
  return [...records.keys()].map((id) => dto(id)!).filter(Boolean);
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
