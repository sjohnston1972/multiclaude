// Regression coverage for the restore API surface. The full cross-restart
// behaviour (respawn with same ids, command re-run, ask-first) is verified by
// actually restarting the server — see the workspace-restore notes in README —
// since `restorable` is only loaded from disk at server startup.
const BASE = "http://127.0.0.1:3001";
let failures = 0;
const check = (n, c, e = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${c ? "" : " " + e}`); if (!c) failures++; };

const rest = await (await fetch(BASE + "/api/sessions/restorable")).json();
check("restorable returns an array", Array.isArray(rest));

const restored = await (await fetch(BASE + "/api/sessions/restore", { method: "POST" })).json();
check("restore returns an array", Array.isArray(restored));

const dismiss = await (await fetch(BASE + "/api/sessions/restore/dismiss", { method: "POST" })).json();
check("dismiss returns ok", dismiss.ok === true);

const restAfter = await (await fetch(BASE + "/api/sessions/restorable")).json();
check("restorable empty after dismiss", restAfter.length === 0);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
