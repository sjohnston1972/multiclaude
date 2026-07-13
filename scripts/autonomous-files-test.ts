// Verifies the side-pane files endpoint (Step 10): GET /api/autonomous/:id/files
// returns PLAN.md + PROGRESS.md contents and a blockersPresent flag that only
// fires on a populated `## Blockers` section. In-process via app.inject().
// Run with:  npx tsx scripts/autonomous-files-test.ts

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

function seed(progressBody: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-files-"));
  fs.writeFileSync(path.join(dir, "PLAN.md"), "1. scaffold the thing\n2. wire it up\n");
  fs.writeFileSync(path.join(dir, "PROGRESS.md"), progressBody);
  return dir;
}

process.env.STUB_SCENARIO = "done";
__setSpawnOverride({ command: process.execPath, args: [stub] });

const app = Fastify();
registerAutonomousRoutes(app);

// --- a run WITH a populated Blockers section --------------------------------
const dirBlocked = seed("# PROGRESS\n\n## Blockers\n- Step 2 needs a secret not in .env\n");
const created = (await app.inject({ method: "POST", url: "/api/autonomous", payload: { taskName: "blocked-run", projectDir: dirBlocked } })).json();
const files = (await app.inject({ url: `/api/autonomous/${created.id}/files` })).json();
check("returns PLAN.md contents", typeof files.plan === "string" && files.plan.includes("scaffold the thing"));
check("returns PROGRESS.md contents", typeof files.progress === "string" && files.progress.includes("secret not in .env"));
check("blockersPresent true on populated section", files.blockersPresent === true, JSON.stringify(files.blockersPresent));

// --- a run with only the empty template section -----------------------------
const dirClean = seed("# PROGRESS\n\n## Blockers\n\n<!-- write here -->\n");
const created2 = (await app.inject({ method: "POST", url: "/api/autonomous", payload: { taskName: "clean-run", projectDir: dirClean } })).json();
const files2 = (await app.inject({ url: `/api/autonomous/${created2.id}/files` })).json();
check("blockersPresent false on empty template section", files2.blockersPresent === false, JSON.stringify(files2.blockersPresent));

// --- unknown tab ------------------------------------------------------------
const missing = await app.inject({ url: "/api/autonomous/nope/files" });
check("unknown tab → 404 + error", missing.statusCode === 404 && typeof missing.json().error === "string");

__resetForTests();
await app.close();
await new Promise((r) => setTimeout(r, 300));
for (const d of [dirBlocked, dirClean]) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* OS reaps temp later */
  }
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
