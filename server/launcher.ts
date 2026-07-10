import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readState } from "./stateStore.js";

const execFileAsync = promisify(execFile);

/**
 * Routes behind the "New session" dialog: a server-side folder browser and a
 * GitHub repo picker that shells out to the `gh` CLI (no OAuth of our own —
 * gh already holds the credentials).
 */

export const workspaceRoot =
  process.env.MULTICLAUDE_WORKSPACES ?? path.join(os.homedir(), "multiclaude-workspaces");

/** Folder paths must be plain absolute drive paths — no UNC, no traversal tricks. */
function validateDirPath(input: string): string | null {
  const resolved = path.resolve(input);
  if (!/^[A-Za-z]:[\\/]/.test(resolved)) return null; // must be C:\... style
  if (resolved.startsWith("\\\\")) return null; // no UNC shares
  try {
    if (!fs.statSync(resolved).isDirectory()) return null;
  } catch {
    return null;
  }
  return resolved;
}

function listDrives(): string[] {
  const drives: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const root = String.fromCharCode(c) + ":\\";
    try {
      fs.accessSync(root);
      drives.push(root);
    } catch {
      // drive letter not present
    }
  }
  return drives;
}

export function registerLauncherRoutes(app: FastifyInstance): void {
  // ---------------------------------------------------------- folder browse
  app.get("/api/browse", async (req, reply) => {
    const { path: q } = req.query as { path?: string };

    if (!q) {
      return {
        path: null,
        parent: null,
        home: os.homedir(),
        dirs: [],
        drives: listDrives(),
        recent: readState().recentFolders.filter((f) => fs.existsSync(f)),
      };
    }

    const resolved = validateDirPath(q);
    if (!resolved) {
      reply.code(400);
      return { error: `Not a browsable folder: ${q}` };
    }

    let dirs: string[] = [];
    try {
      dirs = fs
        .readdirSync(resolved, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    } catch {
      reply.code(403);
      return { error: `Can't read that folder (access denied): ${resolved}` };
    }

    const parent = path.dirname(resolved);
    return {
      path: resolved,
      parent: parent !== resolved ? parent : null,
      home: os.homedir(),
      dirs,
      drives: [],
      recent: readState().recentFolders.filter((f) => fs.existsSync(f)),
    };
  });

  // ------------------------------------------------------------ github repos
  app.get("/api/github/repos", async (_req, reply) => {
    try {
      const { stdout } = await execFileAsync(
        "gh",
        ["repo", "list", "--json", "name,owner,updatedAt", "--limit", "50"],
        { timeout: 20_000, windowsHide: true }
      );
      const raw = JSON.parse(stdout) as {
        name: string;
        owner: { login: string };
        updatedAt: string;
      }[];
      return {
        repos: raw.map((r) => ({
          name: r.name,
          nameWithOwner: `${r.owner.login}/${r.name}`,
          updatedAt: r.updatedAt,
          cloned: fs.existsSync(path.join(workspaceRoot, r.name)),
        })),
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      reply.code(400);
      if (e.code === "ENOENT") {
        return {
          error:
            "GitHub CLI (gh) isn't installed. Install it from https://cli.github.com, run 'gh auth login', then try again.",
        };
      }
      if (/auth\s*login|not logged in|authentication/i.test(e.stderr ?? "")) {
        return {
          error: "GitHub CLI isn't signed in. Run 'gh auth login' in any terminal, then try again.",
        };
      }
      return { error: `gh failed: ${(e.stderr ?? e.message ?? "unknown error").trim()}` };
    }
  });

  // ------------------------------------------------------------ github clone
  app.post("/api/github/clone", async (req, reply) => {
    const body = (req.body ?? {}) as { nameWithOwner?: string };
    const nameWithOwner = body.nameWithOwner ?? "";
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(nameWithOwner)) {
      reply.code(400);
      return { error: "Invalid repository name" };
    }
    const repoName = nameWithOwner.split("/")[1];
    const target = path.join(workspaceRoot, repoName);

    if (fs.existsSync(target)) {
      return { path: target, existing: true };
    }

    fs.mkdirSync(workspaceRoot, { recursive: true });
    try {
      await execFileAsync("gh", ["repo", "clone", nameWithOwner, target], {
        timeout: 300_000,
        windowsHide: true,
      });
      return { path: target, existing: false };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      reply.code(500);
      if (e.code === "ENOENT") {
        return { error: "GitHub CLI (gh) isn't installed. Install it from https://cli.github.com." };
      }
      return { error: `Clone failed: ${(e.stderr ?? e.message ?? "unknown error").trim()}` };
    }
  });
}
