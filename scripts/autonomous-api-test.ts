// Verifies the autonomous REST routes (Step 7): create → {id,state}, list, get,
// and the error envelope on bad input. In-process via Fastify's app.inject() —
// no external server, no port, stub injected through the registry seam.
// Run with:  npx tsx scripts/autonomous-api-test.ts

import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerAutonomousRoutes } from "../server/autonomous/routes.js";
import { __setSpawnOverride, __resetForTests } from "../server/autonomous/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stub = path.join(__dirname, "_stub", "fake-claude.mjs");

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};

// A valid project dir the integrity guard is happy with.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-api-"));
fs.writeFileSync(path.join(dir, "PLAN.md"), "1. do a thing\n");
fs.writeFileSync(path.join(dir, "PROGRESS.md"), "## Blockers\n");

process.env.STUB_SCENARIO = "done"; // created tabs settle quickly, no runaway loop
__setSpawnOverride({ command: process.execPath, args: [stub] });

const app = Fastify();
registerAutonomousRoutes(app);

// create
const created = await app.inject({ method: "POST", url: "/api/autonomous", payload: { taskName: "my-task", projectDir: dir } });
const createdBody = created.json();
check("create → 200", created.statusCode === 200, String(created.statusCode));
check("create returns id + state", typeof createdBody.id === "string" && typeof createdBody.state === "string", JSON.stringify(createdBody));
check("create pins a session UUID", /^[0-9a-f-]{36}$/.test(createdBody.sessionId), createdBody.sessionId);
const id = createdBody.id;

// list
const list = await app.inject({ url: "/api/autonomous" });
check("list → 200 and includes the tab", list.statusCode === 200 && list.json().some((t: { id: string }) => t.id === id));

// get one
const one = await app.inject({ url: `/api/autonomous/${id}` });
check("get one → 200 with state", one.statusCode === 200 && typeof one.json().state === "string");

// get missing → 404
const missing = await app.inject({ url: "/api/autonomous/nope123" });
check("get unknown → 404 + error", missing.statusCode === 404 && typeof missing.json().error === "string");

// bad create: missing taskName → 400
const bad1 = await app.inject({ method: "POST", url: "/api/autonomous", payload: { projectDir: dir } });
check("missing taskName → 400 + error", bad1.statusCode === 400 && typeof bad1.json().error === "string");

// bad create: non-existent dir → 400
const bad2 = await app.inject({ method: "POST", url: "/api/autonomous", payload: { taskName: "x", projectDir: path.join(dir, "nope") } });
check("bad projectDir → 400 + error", bad2.statusCode === 400 && typeof bad2.json().error === "string");

__resetForTests();
await app.close();
// Best-effort temp cleanup — a just-killed child can briefly hold the cwd on Windows.
await new Promise((r) => setTimeout(r, 300));
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  /* OS will reap the temp dir later */
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
