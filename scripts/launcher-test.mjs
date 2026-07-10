// Tests the launcher endpoints: folder browse validation and gh error handling.
const BASE = "http://127.0.0.1:3001";
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " " + extra}`);
  if (!cond) failures++;
};

// drive list
const root = await (await fetch(`${BASE}/api/browse`)).json();
check("drive list", Array.isArray(root.drives) && root.drives.includes("C:\\"), JSON.stringify(root));

// browse real folder
const proj = await (await fetch(`${BASE}/api/browse?path=${encodeURIComponent("C:\\cloudflare_projects")}`)).json();
check("browse folder", proj.dirs.includes("multiclaude"), JSON.stringify(proj).slice(0, 200));
check("parent set", proj.parent === "C:\\");

// UNC rejected
const unc = await fetch(`${BASE}/api/browse?path=${encodeURIComponent("\\\\evil\\share")}`);
check("UNC rejected", unc.status === 400);

// nonexistent rejected
const nope = await fetch(`${BASE}/api/browse?path=${encodeURIComponent("C:\\no-such-dir-zzz")}`);
check("missing folder rejected", nope.status === 400);

// file (not dir) rejected
const file = await fetch(`${BASE}/api/browse?path=${encodeURIComponent("C:\\cloudflare_projects\\multiclaude\\package.json")}`);
check("file rejected", file.status === 400);

// bad worktree name rejected
const badWt = await fetch(`${BASE}/api/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ autoClaude: true, worktree: "bad name; rm -rf" }),
});
check("bad worktree name rejected", badWt.status === 400);

// bad clone name rejected
const badClone = await fetch(`${BASE}/api/github/clone`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ nameWithOwner: "owner/repo; echo pwned" }),
});
check("bad clone name rejected", badClone.status === 400);

// gh repos — either a repo list or a friendly error, never a crash
const gh = await fetch(`${BASE}/api/github/repos`);
const ghBody = await gh.json();
check(
  "gh repos responds sanely",
  (gh.ok && Array.isArray(ghBody.repos)) || (!gh.ok && typeof ghBody.error === "string"),
  JSON.stringify(ghBody).slice(0, 200)
);
console.log("  gh result:", JSON.stringify(ghBody).slice(0, 160));

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
