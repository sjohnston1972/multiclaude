// Verifies restart survival + relaunch (Step 12): a persisted, non-live tab
// relaunches into a running state, reusing its pinned UUID, and the pinned
// invocation resumes (--resume) rather than re-pinning (--session-id).
// Run with:  npx tsx scripts/autonomous-relaunch-test.ts

import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerAutonomousRoutes } from "../server/autonomous/routes.js";
import { __setSpawnOverride, __resetForTests, loadPersisted } from "../server/autonomous/registry.js";
import { buildClaudeArgs } from "../server/autonomous/manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stub = path.join(__dirname, "_stub", "fake-claude.mjs");

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};

// --- buildClaudeArgs: resume vs first-call ----------------------------------
const uuid = "11111111-2222-3333-4444-555555555555";
const first = buildClaudeArgs({ cwd: "." }, uuid, false);
const resumed = buildClaudeArgs({ cwd: "." }, uuid, true);
check("first call uses --session-id <uuid>", first.includes("--session-id") && first[first.indexOf("--session-id") + 1] === uuid && !first.includes("--resume"));
check("resume call uses --resume <uuid>", resumed.includes("--resume") && resumed[resumed.indexOf("--resume") + 1] === uuid && !resumed.includes("--session-id"));

// --- persisted-but-dead tab relaunches --------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-relaunch-dir-"));
fs.writeFileSync(path.join(dir, "PLAN.md"), "1. do a thing\n");
fs.writeFileSync(path.join(dir, "PROGRESS.md"), "## Blockers\n");

const recordsFile = path.join(os.tmpdir(), `mc-relaunch-${process.pid}.json`);
const persistedUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
fs.writeFileSync(
  recordsFile,
  JSON.stringify([
    {
      id: "tab-abc",
      taskName: "revive-me",
      projectDir: dir,
      addDirs: [],
      model: "sonnet",
      budgetUsd: null,
      extraAllowRules: "",
      sessionId: persistedUuid,
      launchTag: "multiclaude-launch-revive-me-1",
      state: "error", // died mid-run when the server stopped
      currentStep: "Step 2",
      startedAt: Date.now() - 1000,
      lastTurnAt: Date.now() - 500,
      costUsd: 0.5,
      lastError: "server stopped",
    },
  ])
);
process.env.MULTICLAUDE_AUTONOMOUS_FILE = recordsFile;
process.env.STUB_SCENARIO = "done";
__setSpawnOverride({ command: process.execPath, args: [stub] });

loadPersisted();

const app = Fastify();
registerAutonomousRoutes(app);

// It should come back as relaunchable, not running.
const before = (await app.inject({ url: "/api/autonomous/tab-abc" })).json();
check("persisted tab is relaunchable, not running", before.relaunchable === true && before.state !== "running", JSON.stringify({ r: before.relaunchable, s: before.state }));

const res = await app.inject({ method: "POST", url: "/api/autonomous/tab-abc/relaunch" });
const relaunched = res.json();
check("relaunch → 200", res.statusCode === 200, String(res.statusCode));
check("relaunched into a live state", relaunched.state === "running" || relaunched.state === "done", relaunched.state);
check("relaunch reused the pinned UUID", relaunched.sessionId === persistedUuid, relaunched.sessionId);
check("relaunch of unknown tab → 404", (await app.inject({ method: "POST", url: "/api/autonomous/nope/relaunch" })).statusCode === 404);

__resetForTests();
await app.close();
await new Promise((r) => setTimeout(r, 300));
try {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(recordsFile, { force: true });
} catch {
  /* best effort */
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
