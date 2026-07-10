// Tests: mkdir git-init, isRepo detection in session info, publish validation.
// Does NOT create a real GitHub repo (outward-facing) — publish happy path is
// the user's to run.
import fs from "node:fs";
import path from "node:path";
const BASE = "http://127.0.0.1:3001";
let failures = 0;
const check = (n, c, e = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${c ? "" : " " + e}`); if (!c) failures++; };
const post = (u, b) => fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parent = "C:\\cloudflare_projects\\multiclaude";

// --- mkdir with git init
const folder = "mc-git-test-" + Math.floor(Date.now() / 1000);
const mk = await (await post("/api/mkdir", { parent, name: folder, git: true })).json();
const made = path.join(parent, folder);
check("mkdir git:true creates folder", fs.existsSync(made));
check("mkdir git:true reports git", mk.git === true, JSON.stringify(mk));
check(".git directory exists", fs.existsSync(path.join(made, ".git")));

// --- session in the new repo reports isRepo=true (branch main from init -b main)
const s = await (await post("/api/sessions", { cwd: made })).json();
await sleep(1200); // let the git refresh run
const listA = await (await fetch(BASE + "/api/sessions")).json();
const meA = listA.find((x) => x.id === s.id);
check("new git folder session isRepo=true", meA?.isRepo === true, JSON.stringify(meA));
check("new git folder branch is main", meA?.branch === "main", `branch=${meA?.branch}`);
await fetch(`${BASE}/api/sessions/${s.id}`, { method: "DELETE" });

// --- session in a plain (non-repo) folder reports isRepo=false
// Must be OUTSIDE any git repo (a subfolder of a repo is still "inside a work
// tree"), so use the OS temp dir.
const plain = path.join(process.env.TEMP ?? "C:\\Windows\\Temp", "mc-plain-" + Math.floor(Date.now() / 1000));
fs.mkdirSync(plain);
const s2 = await (await post("/api/sessions", { cwd: plain })).json();
await sleep(1200);
const listB = await (await fetch(BASE + "/api/sessions")).json();
const meB = listB.find((x) => x.id === s2.id);
check("plain folder session isRepo=false", meB?.isRepo === false, JSON.stringify(meB));
await fetch(`${BASE}/api/sessions/${s2.id}`, { method: "DELETE" });

// cleanup created folders
fs.rmSync(made, { recursive: true, force: true });
fs.rmSync(plain, { recursive: true, force: true });

// --- publish validation (no real repo created)
const noVis = await post("/api/github/publish", { path: parent, name: "x" });
check("publish requires visibility", noVis.status === 400);
const badName = await post("/api/github/publish", { path: parent, name: "bad name;rm", visibility: "private" });
check("publish rejects bad name", badName.status === 400);
const badPath = await post("/api/github/publish", { path: "C:\\no-such-zzz", name: "ok", visibility: "private" });
check("publish rejects bad path", badPath.status === 400);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
