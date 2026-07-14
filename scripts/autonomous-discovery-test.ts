// Verifies autonomous-capable repo detection (tagging feature): status derived
// from PLAN.md / PROGRESS.md / DONE, listAutonomousRepos filters + dedupes, and
// GET /api/autonomous/ready returns the right shape.
// Run with:  npx tsx scripts/autonomous-discovery-test.ts

import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { autonomousStatus, listAutonomousRepos } from "../server/autonomous/discovery.js";
import { registerAutonomousRoutes } from "../server/autonomous/routes.js";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};

function mk(files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-disc-"));
  for (const f of files) fs.writeFileSync(path.join(dir, f), "");
  return dir;
}

// --- status derivation ------------------------------------------------------
const none = mk([]);
const drafting = mk(["PLAN.md"]);
const ready = mk(["PLAN.md", "PROGRESS.md"]);
const completed = mk(["PLAN.md", "PROGRESS.md", "DONE"]);

check("no state files → none", autonomousStatus(none).status === "none");
check("PLAN only → drafting", autonomousStatus(drafting).status === "drafting");
check("PLAN + PROGRESS → ready", autonomousStatus(ready).status === "ready");
check("PLAN + PROGRESS + DONE → completed", autonomousStatus(completed).status === "completed");
check("reports the individual file flags", (() => {
  const s = autonomousStatus(completed);
  return s.hasPlan && s.hasProgress && s.hasDone && s.name.startsWith("mc-disc-");
})());

// --- listing filters + dedupes ----------------------------------------------
const list = listAutonomousRepos([none, drafting, ready, completed, ready /* dup */]);
check("filters out non-autonomous dirs", !list.some((r) => r.path === none));
check("keeps the three autonomous repos", list.length === 3, `got ${list.length}`);
check("dedupes repeated paths", list.filter((r) => path.resolve(r.path) === path.resolve(ready)).length === 1);

// --- endpoint shape ---------------------------------------------------------
const app = Fastify();
registerAutonomousRoutes(app);
const res = await app.inject({ url: "/api/autonomous/ready" });
check("GET /api/autonomous/ready → 200", res.statusCode === 200, String(res.statusCode));
check("returns a repos array", Array.isArray(res.json().repos));
await app.close();

for (const d of [none, drafting, ready, completed]) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
