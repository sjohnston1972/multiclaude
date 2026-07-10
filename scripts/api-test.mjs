// Exercises the REST API: session create/list/ensure/kill and state roundtrip.
const BASE = "http://127.0.0.1:3001";
let failures = 0;

function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " " + extra}`);
  if (!cond) failures++;
}

const j = (r) => r.json();
const post = (url, body) =>
  fetch(BASE + url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// create
const created = await j(await post("/api/sessions", { cwd: "C:\\cloudflare_projects" }));
check("create session", !!created.id && created.cwd === "C:\\cloudflare_projects", JSON.stringify(created));

// list
const list = await j(await fetch(BASE + "/api/sessions"));
check("session in list", list.some((s) => s.id === created.id));

// create with bad folder → 400
const bad = await post("/api/sessions", { cwd: "C:\\does-not-exist-xyz" });
check("bad folder rejected", bad.status === 400);

// ensure existing → created:false
const ensured = await j(await post(`/api/sessions/${created.id}/ensure`, {}));
check("ensure existing", ensured.created === false);

// ensure new id → created:true with cwd
const ensured2 = await j(await post(`/api/sessions/test-ensure-1/ensure`, { cwd: "C:\\cloudflare_projects" }));
check("ensure respawn", ensured2.created === true && ensured2.cwd === "C:\\cloudflare_projects");

// state roundtrip
const putRes = await fetch(BASE + "/api/state", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ layout: { marker: "api-test" }, settings: { fontSize: 16 } }),
});
check("state PUT ok", putRes.ok);
const state = await j(await fetch(BASE + "/api/state"));
check("state roundtrip", state.layout?.marker === "api-test" && state.settings.fontSize === 16);
check("recent folders recorded", state.recentFolders.includes("C:\\cloudflare_projects"));

// kill both test sessions
for (const id of [created.id, "test-ensure-1"]) {
  const del = await fetch(`${BASE}/api/sessions/${id}`, { method: "DELETE" });
  check(`kill ${id}`, del.ok);
}
await new Promise((r) => setTimeout(r, 1500));
const after = await j(await fetch(BASE + "/api/sessions"));
check("sessions gone after kill", !after.some((s) => s.id === created.id || s.id === "test-ensure-1"));

// restore default settings so the user's state isn't left with test values
await fetch(BASE + "/api/state", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ layout: null, settings: { fontSize: 14 } }),
});

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
