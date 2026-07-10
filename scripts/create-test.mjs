// Tests create-folder (fully) and create-repo (validation only — we don't
// create a real GitHub repo automatically; that's the user's call).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const BASE = "http://127.0.0.1:3001";
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " " + extra}`);
  if (!cond) failures++;
};
const post = (u, b) =>
  fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

const parent = "C:\\cloudflare_projects\\multiclaude";

// --- mkdir happy path
const folderName = "mc-test-" + Math.floor(Date.now() / 1000);
const mk = await post("/api/mkdir", { parent, name: folderName });
const mkBody = await mk.json();
const made = path.join(parent, folderName);
check("mkdir creates folder", mk.ok && mkBody.path === made && fs.existsSync(made), JSON.stringify(mkBody));

// --- mkdir rejects duplicate
const dup = await post("/api/mkdir", { parent, name: folderName });
check("mkdir rejects duplicate", dup.status === 409);

// --- mkdir rejects traversal / bad names
const bad1 = await post("/api/mkdir", { parent, name: "..\\escape" });
check("mkdir rejects traversal name", bad1.status === 400);
const bad2 = await post("/api/mkdir", { parent, name: "bad/slash" });
check("mkdir rejects slash name", bad2.status === 400);
const bad3 = await post("/api/mkdir", { parent: "\\\\unc\\share", name: "x" });
check("mkdir rejects UNC parent", bad3.status === 400);

// cleanup the created folder
if (fs.existsSync(made)) fs.rmdirSync(made);
check("mkdir cleanup", !fs.existsSync(made));

// --- mkdir with a starter file
const folderF = "mc-file-" + Math.floor(Date.now() / 1000);
const madeF = path.join(parent, folderF);
const fileBody = "# Seeded\nhello";
const mkf = await (await post("/api/mkdir", { parent, name: folderF, file: { name: "CLAUDE.md", content: fileBody } })).json();
check("mkdir writes starter file", mkf.file === "CLAUDE.md" && fs.existsSync(path.join(madeF, "CLAUDE.md")));
check("starter file content matches", fs.existsSync(path.join(madeF, "CLAUDE.md")) && fs.readFileSync(path.join(madeF, "CLAUDE.md"), "utf8") === fileBody);
// bad file name rejected (folder must not be created)
const folderF2 = "mc-file2-" + Math.floor(Date.now() / 1000);
const badFile = await post("/api/mkdir", { parent, name: folderF2, file: { name: "../evil", content: "x" } });
check("starter file traversal name rejected", badFile.status === 400);
check("folder not created when file name invalid", !fs.existsSync(path.join(parent, folderF2)));
fs.rmSync(madeF, { recursive: true, force: true });

// --- github/create validation (no real repo created)
const noVis = await post("/api/github/create", { name: "some-repo" });
check("create-repo requires visibility", noVis.status === 400, `status ${noVis.status}`);
const badName = await post("/api/github/create", { name: "bad name;rm", visibility: "private" });
check("create-repo rejects bad name", badName.status === 400);
// existing workspace folder → 409 (multiclaude repo dir won't exist in workspace, so use a name that does)
const wsRoot = process.env.MULTICLAUDE_WORKSPACES ?? path.join(os.homedir(), "multiclaude-workspaces");
fs.mkdirSync(path.join(wsRoot, "mc-exists-test"), { recursive: true });
const exists = await post("/api/github/create", { name: "mc-exists-test", visibility: "private" });
check("create-repo rejects existing workspace folder", exists.status === 409, `status ${exists.status}`);
fs.rmdirSync(path.join(wsRoot, "mc-exists-test"));

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
