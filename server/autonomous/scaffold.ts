import fs from "node:fs";
import path from "node:path";
import { PLAN_TEMPLATE, PROGRESS_HEADER } from "./templates.js";

/**
 * "New autonomous project" scaffold (R12): drop a PLAN.md (from the standard
 * template) and a PROGRESS.md (standard header) into a target dir. Refuses to
 * overwrite — the user's plan is the highest-leverage artifact and we never
 * clobber it.
 */
export function scaffoldProject(targetDir: string): { created: string[]; conflict?: string } {
  const plan = path.join(targetDir, "PLAN.md");
  const progress = path.join(targetDir, "PROGRESS.md");
  const existing = [plan, progress].filter((p) => fs.existsSync(p)).map((p) => path.basename(p));
  if (existing.length) return { created: [], conflict: existing.join(", ") };

  fs.writeFileSync(plan, PLAN_TEMPLATE);
  fs.writeFileSync(progress, PROGRESS_HEADER);
  return { created: ["PLAN.md", "PROGRESS.md"] };
}
