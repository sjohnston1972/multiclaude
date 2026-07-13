// Verifies the PLAN.md path scan (Step 14, R6.5): a sibling-repo absolute path is
// flagged unreachable, an --add-dir makes it reachable, a `..` traversal and an
// unresolved env var are flagged, and an in-repo path is clean.
// Run with:  npx tsx scripts/pathscan-test.ts

import path from "node:path";
import { scanPlanForPaths } from "../server/autonomous/pathScan.js";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};

const repo = path.resolve("C:/repo");
const sibling = "C:\\other-repo\\lib\\thing.ts";
const plan = [
  "5. Edit `server/lib/auth.ts` and read `../other-repo/lib/thing.ts`.",
  "6. Copy from `" + sibling + "` into place.",
  "7. Load config from `$SECRET_DIR/config.json`.",
  "8. Touch `src/index.ts` only.",
].join("\n");

// --- without any add-dir ----------------------------------------------------
const rows = scanPlanForPaths(plan, repo, []);
const find = (frag: string) => rows.find((r) => r.path.includes(frag));

const siblingRow = find("other-repo\\lib\\thing.ts") ?? find("other-repo/lib/thing.ts");
check("sibling absolute path found", !!siblingRow, JSON.stringify(rows.map((r) => r.path)));
check("sibling path unreachable without add-dir", siblingRow?.reachable === false, JSON.stringify(siblingRow));
check("sibling path flagged outside-repo", siblingRow?.issue === "outside-repo");

const traversal = find("..");
check("../ traversal flagged", traversal?.issue === "traversal", JSON.stringify(traversal));

const env = rows.find((r) => r.issue === "unresolved-env");
check("unresolved env var flagged", !!env && env.resolvesTo === null, JSON.stringify(env));

const inRepo = find("src/index.ts");
check("in-repo path reachable, no issue", inRepo?.reachable === true && inRepo?.issue === null, JSON.stringify(inRepo));

// --- adding the sibling repo as an --add-dir flips it to reachable -----------
const rows2 = scanPlanForPaths(plan, repo, ["C:/other-repo"]);
const siblingRow2 = rows2.find((r) => r.path.toLowerCase().includes("other-repo\\lib") || r.path.toLowerCase().includes("other-repo/lib"));
check("sibling reachable once its parent is an --add-dir", siblingRow2?.reachable === true, JSON.stringify(siblingRow2));

// --- a resolvable env var resolves and is judged on its target --------------
process.env.MC_TEST_DIR = "C:/repo/generated";
const rows3 = scanPlanForPaths("Write `%MC_TEST_DIR%/out.ts`.", repo, []);
const resolved = rows3[0];
check("resolvable env var resolves (not flagged unresolved)", resolved?.issue !== "unresolved-env" && resolved?.resolvesTo !== null, JSON.stringify(resolved));
check("resolved env var inside repo is reachable", resolved?.reachable === true, JSON.stringify(resolved));

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
