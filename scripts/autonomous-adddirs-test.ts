// Verifies per-project --add-dir memory + the sibling quick-pick endpoint.
// Run with:  npx tsx scripts/autonomous-adddirs-test.ts

import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAddDirs, writeAddDirs } from "../server/autonomous/addDirsStore.js";
import { registerAutonomousRoutes } from "../server/autonomous/routes.js";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};

const store = path.join(os.tmpdir(), `mc-adddirs-${process.pid}.json`);
process.env.MULTICLAUDE_ADDDIRS_FILE = store;

// --- store round-trip -------------------------------------------------------
check("empty for an unknown project", readAddDirs("C:/nope").length === 0);
writeAddDirs("C:/proj", ["C:/proj/../sibling", "  C:/other  ", "C:/proj/../sibling"]);
const got = readAddDirs("C:/proj");
check("persists, trims, dedupes", JSON.stringify(got) === JSON.stringify(["C:/proj/../sibling", "C:/other"]), JSON.stringify(got));
check("keyed case-insensitively by resolved path", readAddDirs("c:/PROJ").length === 2);
writeAddDirs("C:/proj", []);
check("clearing removes the entry", readAddDirs("C:/proj").length === 0);

// --- endpoint: remembered + siblings ----------------------------------------
// A parent with three sibling dirs; make one the "project".
const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mc-sib-"));
for (const n of ["project", "skills-foundry", "other-lib"]) fs.mkdirSync(path.join(parent, n));
const project = path.join(parent, "project");
writeAddDirs(project, [path.join(parent, "skills-foundry")]);

const app = Fastify();
registerAutonomousRoutes(app);
const res = (await app.inject({ url: `/api/autonomous/adddirs?projectDir=${encodeURIComponent(project)}` })).json();
check("endpoint returns remembered grants", Array.isArray(res.remembered) && res.remembered.length === 1 && res.remembered[0].includes("skills-foundry"));
const sibNames = (res.siblings ?? []).map((s: { name: string }) => s.name).sort();
check("siblings list the parent's other dirs, not the project itself", JSON.stringify(sibNames) === JSON.stringify(["other-lib", "skills-foundry"]), JSON.stringify(sibNames));
check("no projectDir → empty", (await app.inject({ url: "/api/autonomous/adddirs" })).json().siblings.length === 0);
await app.close();

for (const p of [store, parent]) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
