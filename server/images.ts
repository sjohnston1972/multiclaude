import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { imagesDir } from "./stateStore.js";

/**
 * Image paste support: the browser POSTs clipboard/dropped images here, we
 * save them under %LOCALAPPDATA%\multiclaude\images\, and the client types
 * the quoted file path into the terminal — Claude Code reads the file itself.
 */

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // prune images older than 7 days

export function pruneOldImages(): void {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(imagesDir)) {
      const file = path.join(imagesDir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > MAX_AGE_MS) fs.unlinkSync(file);
      } catch {
        // file vanished or locked — skip
      }
    }
  } catch {
    // images dir doesn't exist yet
  }
}

export function registerImageRoutes(app: FastifyInstance): void {
  app.addContentTypeParser(
    Object.keys(EXTENSIONS),
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body)
  );

  app.post("/api/images", async (req, reply) => {
    const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim();
    const ext = EXTENSIONS[contentType];
    if (!ext) {
      reply.code(415);
      return { error: "Only PNG, JPEG, GIF or WebP images are supported" };
    }
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      reply.code(400);
      return { error: "Empty image upload" };
    }
    fs.mkdirSync(imagesDir, { recursive: true });
    // Timestamp + counter avoids collisions when pasting rapidly.
    const file = path.join(imagesDir, `${Date.now()}-${counter++}.${ext}`);
    fs.writeFileSync(file, buf);
    return { path: file };
  });
}

let counter = 0;
