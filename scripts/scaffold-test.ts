// Verifies the scaffold action (Step 18, R12): scaffolding an empty dir creates
// a PLAN.md (with the Invariants line) and PROGRESS.md (with a Blockers section);
// a second scaffold over existing files returns 409. In-process via app.inject().
// Run with:  npx tsx scripts/scaffold-test.ts

import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerAutonomousRoutes } from "../server/autonomous/routes.js";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-scaffold-"));

const app = Fastify();
registerAutonomousRoutes(app);

const res = await app.inject({ method: "POST", url: "/api/autonomous/scaffold", payload: { projectDir: dir } });
check("scaffold → 200", res.statusCode === 200, String(res.statusCode));
check("reports both files created", JSON.stringify(res.json().created) === JSON.stringify(["PLAN.md", "PROGRESS.md"]));

const plan = fs.readFileSync(path.join(dir, "PLAN.md"), "utf8");
const progress = fs.readFileSync(path.join(dir, "PROGRESS.md"), "utf8");
check("PLAN.md exists with the Invariants line", plan.includes("Invariants (apply to every step)"));
check("PROGRESS.md exists with a Blockers section", /^##\s+Blockers/m.test(progress));

// second scaffold refuses to overwrite
const again = await app.inject({ method: "POST", url: "/api/autonomous/scaffold", payload: { projectDir: dir } });
check("second scaffold → 409 + error", again.statusCode === 409 && typeof again.json().error === "string", String(again.statusCode));

// missing dir → 400
const bad = await app.inject({ method: "POST", url: "/api/autonomous/scaffold", payload: { projectDir: path.join(dir, "nope") } });
check("missing dir → 400", bad.statusCode === 400);

await app.close();
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  /* best effort */
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
