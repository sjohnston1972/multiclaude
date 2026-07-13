// Verifies autonomous tab persistence (Step 11): creating a tab writes an R9
// record to autonomous.json (atomic), with the pinned UUID and all fields, and
// loadPersisted brings it back after a "restart". Isolated via the file override.
// Run with:  npx tsx scripts/autonomous-persist-test.ts

import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerAutonomousRoutes } from "../server/autonomous/routes.js";
import { __setSpawnOverride, __resetForTests, loadPersisted, listTabs } from "../server/autonomous/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stub = path.join(__dirname, "_stub", "fake-claude.mjs");

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};

const recordsFile = path.join(os.tmpdir(), `mc-persist-${process.pid}.json`);
process.env.MULTICLAUDE_AUTONOMOUS_FILE = recordsFile;
process.env.STUB_SCENARIO = "done";
__setSpawnOverride({ command: process.execPath, args: [stub] });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-persist-dir-"));
fs.writeFileSync(path.join(dir, "PLAN.md"), "1. do a thing\n");
fs.writeFileSync(path.join(dir, "PROGRESS.md"), "## Blockers\n");

const app = Fastify();
registerAutonomousRoutes(app);

const created = (await app.inject({ method: "POST", url: "/api/autonomous", payload: { taskName: "persist-me", projectDir: dir } })).json();
// Give the state-change persist() a tick to flush.
await new Promise((r) => setTimeout(r, 200));

check("autonomous.json was written", fs.existsSync(recordsFile));
const onDisk = JSON.parse(fs.readFileSync(recordsFile, "utf8"));
check("file holds an array with our record", Array.isArray(onDisk) && onDisk.some((r: { id: string }) => r.id === created.id));
const rec = onDisk.find((r: { id: string }) => r.id === created.id);
const r9Fields = ["id", "taskName", "projectDir", "addDirs", "sessionId", "launchTag", "state", "currentStep", "startedAt", "lastTurnAt", "costUsd", "lastError"];
check("record has all R9 fields", r9Fields.every((f) => f in rec), r9Fields.filter((f) => !(f in rec)).join(","));
check("persisted sessionId matches the pinned UUID", rec.sessionId === created.sessionId, `${rec.sessionId} vs ${created.sessionId}`);

// Simulate a restart: forget everything in memory, then load from disk.
__resetForTests();
process.env.MULTICLAUDE_AUTONOMOUS_FILE = recordsFile; // __resetForTests cleared the spawn override only
loadPersisted();
const reloaded = listTabs().find((t) => t.id === created.id);
check("loadPersisted brings the tab back", !!reloaded, JSON.stringify(listTabs().map((t) => t.id)));
check("reloaded tab keeps its pinned UUID", reloaded?.sessionId === created.sessionId);
check("reloaded tab is not shown as running", reloaded?.state !== "running", reloaded?.state);

__resetForTests();
await app.close();
try {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(recordsFile, { force: true });
} catch {
  /* best effort */
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
