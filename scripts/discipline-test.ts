// Verifies the discipline-block append action (R6.6): appends the 7-point block
// to a CLAUDE.md that lacks it, is idempotent (never duplicates / never clobbers
// a shorter existing section), and creates the file when absent. Both directly
// and via POST /api/autonomous/discipline. Isolated via MULTICLAUDE_CLAUDE_MD.
// Run with:  npx tsx scripts/discipline-test.ts

import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendDiscipline, DISCIPLINE_HEADING, DISCIPLINE_BLOCK } from "../server/autonomous/discipline.js";
import { registerAutonomousRoutes } from "../server/autonomous/routes.js";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};
const headingCount = (s: string) => (s.match(/^##\s+Autonomous run discipline/gm) ?? []).length;

// canonical block sanity: it's the 7-point version
check("block is the 7-point version", /^7\.\s+\*\*Never scaffold half a step/m.test(DISCIPLINE_BLOCK));
check("block starts with the heading", DISCIPLINE_HEADING.test(DISCIPLINE_BLOCK));

// --- append into a CLAUDE.md that has other content but no discipline --------
{
  const md = path.join(os.tmpdir(), `mc-disc-a-${process.pid}.md`);
  fs.writeFileSync(md, "# My global rules\n\nBe concise.\n");
  process.env.MULTICLAUDE_CLAUDE_MD = md;

  const r1 = appendDiscipline();
  const after = fs.readFileSync(md, "utf8");
  check("append: appended=true, not alreadyPresent", r1.appended && !r1.alreadyPresent);
  check("append: heading now present", DISCIPLINE_HEADING.test(after));
  check("append: 7th rule present", /Never scaffold half a step/.test(after));
  check("append: preserved the prior content", after.includes("Be concise."));

  // idempotent second call
  const r2 = appendDiscipline();
  const after2 = fs.readFileSync(md, "utf8");
  check("second append: alreadyPresent=true, appended=false", r2.alreadyPresent && !r2.appended);
  check("second append: exactly one discipline heading (no duplicate)", headingCount(after2) === 1, `count=${headingCount(after2)}`);
  fs.rmSync(md, { force: true });
}

// --- creates the file when it doesn't exist ---------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-disc-home-"));
  const md = path.join(dir, ".claude", "CLAUDE.md"); // nested — must be created
  process.env.MULTICLAUDE_CLAUDE_MD = md;
  const r = appendDiscipline();
  check("creates ~/.claude/CLAUDE.md when absent", r.appended && fs.existsSync(md) && DISCIPLINE_HEADING.test(fs.readFileSync(md, "utf8")));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- never clobbers a shorter existing section ------------------------------
{
  const md = path.join(os.tmpdir(), `mc-disc-b-${process.pid}.md`);
  fs.writeFileSync(md, "## Autonomous run discipline\n\n1. only one short rule.\n");
  process.env.MULTICLAUDE_CLAUDE_MD = md;
  const r = appendDiscipline();
  const after = fs.readFileSync(md, "utf8");
  check("shorter existing section left untouched", r.alreadyPresent && after.includes("only one short rule") && !after.includes("Never scaffold half a step"));
  fs.rmSync(md, { force: true });
}

// --- via the route ----------------------------------------------------------
{
  const md = path.join(os.tmpdir(), `mc-disc-route-${process.pid}.md`);
  process.env.MULTICLAUDE_CLAUDE_MD = md;
  const app = Fastify();
  registerAutonomousRoutes(app);
  const res = await app.inject({ method: "POST", url: "/api/autonomous/discipline" });
  check("route → 200 appended", res.statusCode === 200 && res.json().appended === true);
  check("route wrote the block", fs.existsSync(md) && DISCIPLINE_HEADING.test(fs.readFileSync(md, "utf8")));
  await app.close();
  fs.rmSync(md, { force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
