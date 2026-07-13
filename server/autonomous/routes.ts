import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { createTab, getTab, listTabs, type CreateTabInput } from "./registry.js";

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
}
