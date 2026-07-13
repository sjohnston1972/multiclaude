import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createTab, getTab, listTabs, relaunchTab, pauseTab, resumeTab, killTab, rollbackTab, type CreateTabInput } from "./registry.js";
import { hasBlockers } from "./loop.js";
import { runPreflight } from "./preflight.js";
import { prepareLaunch } from "./launch.js";
import { scaffoldProject } from "./scaffold.js";

/**
 * REST API for autonomous tabs. Follows multiclaude's envelope: on failure
 * `reply.code(4xx); return { error: "<plain English>" }`; on success return the
 * resource JSON.
 */
export function registerAutonomousRoutes(app: FastifyInstance): void {
  // Create a tab and start its supervisor. (Step 15 routes this through the full
  // launch sequence — tag, state dir, gitignore — gated on pre-flight.)
  app.post("/api/autonomous", async (req, reply) => {
    const body = (req.body ?? {}) as Partial<CreateTabInput>;

    const taskName = (body.taskName ?? "").trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(taskName)) {
      reply.code(400);
      return { error: "Task name is required and must be kebab-case (letters, numbers, dashes)." };
    }
    const projectDir = (body.projectDir ?? "").trim();
    if (!projectDir) {
      reply.code(400);
      return { error: "A project directory is required." };
    }
    try {
      if (!fs.statSync(projectDir).isDirectory()) throw new Error("not a directory");
    } catch {
      reply.code(400);
      return { error: `Project directory doesn't exist: ${projectDir}` };
    }

    const record = createTab({
      taskName,
      projectDir,
      addDirs: Array.isArray(body.addDirs) ? body.addDirs : [],
      model: body.model,
      budgetUsd: body.budgetUsd ?? null,
      extraAllowRules: body.extraAllowRules,
    });
    return record;
  });

  // Pre-flight validation for the new-tab dialog (R6). Gate Launch on canLaunch.
  app.post("/api/autonomous/preflight", async (req, reply) => {
    const body = (req.body ?? {}) as { projectDir?: string; addDirs?: string[] };
    const projectDir = (body.projectDir ?? "").trim();
    if (!projectDir) {
      reply.code(400);
      return { error: "A project directory is required." };
    }
    return runPreflight(projectDir, Array.isArray(body.addDirs) ? body.addDirs : []);
  });

  // Full launch (R7): pre-flight gate → rollback tag + state dir + gitignore + UUID
  // → start the supervisor. This is the real entry point the new-tab dialog uses.
  app.post("/api/autonomous/launch", async (req, reply) => {
    const body = (req.body ?? {}) as Partial<CreateTabInput> & { seedProgress?: boolean };
    const taskName = (body.taskName ?? "").trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(taskName)) {
      reply.code(400);
      return { error: "Task name is required and must be kebab-case (letters, numbers, dashes)." };
    }
    const projectDir = (body.projectDir ?? "").trim();
    try {
      if (!projectDir || !fs.statSync(projectDir).isDirectory()) throw new Error();
    } catch {
      reply.code(400);
      return { error: `Project directory doesn't exist: ${projectDir}` };
    }

    const addDirs = Array.isArray(body.addDirs) ? body.addDirs : [];
    const pf = await runPreflight(projectDir, addDirs);
    if (!pf.canLaunch) {
      reply.code(400);
      return { error: "Pre-flight has blocking (❌) checks — resolve them before launch.", preflight: pf };
    }

    const sessionId = crypto.randomUUID();
    let launchTag: string;
    try {
      ({ launchTag } = prepareLaunch({
        projectDir,
        taskName,
        sessionId,
        seedProgress: body.seedProgress === true && pf.seedable,
        now: Math.floor(Date.now() / 1000),
      }));
    } catch (err) {
      reply.code(500);
      return { error: `Launch setup failed: ${(err as Error).message}` };
    }

    return createTab({
      taskName,
      projectDir,
      addDirs,
      model: body.model,
      budgetUsd: body.budgetUsd ?? null,
      extraAllowRules: body.extraAllowRules,
      sessionId,
      launchTag,
    });
  });

  // Scaffold PLAN.md + PROGRESS.md from templates into a target dir (R12).
  app.post("/api/autonomous/scaffold", async (req, reply) => {
    const body = (req.body ?? {}) as { projectDir?: string };
    const projectDir = (body.projectDir ?? "").trim();
    try {
      if (!projectDir || !fs.statSync(projectDir).isDirectory()) throw new Error();
    } catch {
      reply.code(400);
      return { error: `Project directory doesn't exist: ${projectDir}` };
    }
    const result = scaffoldProject(projectDir);
    if (result.conflict) {
      reply.code(409);
      return { error: `Won't overwrite existing ${result.conflict} — edit it instead.` };
    }
    return result;
  });

  app.get("/api/autonomous", async () => listTabs());

  app.get("/api/autonomous/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = getTab(id);
    if (!record) {
      reply.code(404);
      return { error: "No such autonomous tab." };
    }
    return record;
  });

  // Relaunch a persisted/stopped run with its pinned UUID (R9). --resume continues
  // the conversation rather than restarting.
  app.post("/api/autonomous/:id/relaunch", async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = relaunchTab(id);
    if (!record) {
      reply.code(404);
      return { error: "No such autonomous tab." };
    }
    return record;
  });

  // R5 controls. pause/resume/kill act on the live manager; rollback resets the repo.
  for (const action of ["pause", "resume", "kill"] as const) {
    app.post(`/api/autonomous/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const fn = { pause: pauseTab, resume: resumeTab, kill: killTab }[action];
      const record = fn(id);
      if (!record) {
        reply.code(404);
        return { error: "No such autonomous tab (or its supervisor isn't live)." };
      }
      return record;
    });
  }

  app.post("/api/autonomous/:id/rollback", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = rollbackTab(id);
    if ("error" in result) {
      reply.code(400);
      return result;
    }
    return result;
  });

  // Live state files for the R4 side pane. blockersPresent is the feature's most
  // important signal — the UI surfaces it prominently.
  app.get("/api/autonomous/:id/files", async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = getTab(id);
    if (!record) {
      reply.code(404);
      return { error: "No such autonomous tab." };
    }
    const read = (name: string): string | null => {
      try {
        return fs.readFileSync(path.join(record.projectDir, name), "utf8");
      } catch {
        return null;
      }
    };
    const progress = read("PROGRESS.md");
    return {
      plan: read("PLAN.md"),
      progress,
      blockersPresent: progress ? hasBlockers(progress) : false,
    };
  });
}
