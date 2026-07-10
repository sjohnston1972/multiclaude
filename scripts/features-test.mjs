// Tests the new endpoints: broadcast, reveal validation, bell field, initial-command timing.
import WebSocket from "ws";
const BASE = "http://127.0.0.1:3001";
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " " + extra}`);
  if (!cond) failures++;
};
const post = (url, body) =>
  fetch(BASE + url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// Two sessions, attach a WS to each, broadcast, confirm both received it.
const s1 = await (await post("/api/sessions", {})).json();
const s2 = await (await post("/api/sessions", {})).json();
await new Promise((r) => setTimeout(r, 700));

function attach(id) {
  const ws = new WebSocket(`ws://127.0.0.1:3001/ws?session=${id}`);
  const box = { out: "" };
  ws.on("message", (m) => {
    const j = JSON.parse(m);
    if (j.type === "output") box.out += j.data;
  });
  return { ws, box };
}
const a1 = attach(s1.id);
const a2 = attach(s2.id);
await new Promise((r) => setTimeout(r, 800));

const br = await (await post("/api/broadcast", { command: "echo broadcast-xyz" })).json();
check("broadcast reports 2 sent", br.sent === 2, JSON.stringify(br));
await new Promise((r) => setTimeout(r, 1500));
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
check("session 1 ran broadcast", strip(a1.box.out).includes("broadcast-xyz"));
check("session 2 ran broadcast", strip(a2.box.out).includes("broadcast-xyz"));
a1.ws.close();
a2.ws.close();

// reveal validation: bad path rejected
const badReveal = await post("/api/reveal", { path: "C:\\no-such-dir-xyz" });
check("reveal rejects bad path", badReveal.status === 400, `status ${badReveal.status}`);
const uncReveal = await post("/api/reveal", { path: "\\\\evil\\share" });
check("reveal rejects UNC", uncReveal.status === 400);

// bell field present in session info
const list = await (await fetch(BASE + "/api/sessions")).json();
check("lastBellAt present in session info", list.every((s) => typeof s.lastBellAt === "number"));

// initial command: auto-claude session should type the command after first output
const auto = await (await post("/api/sessions", { autoClaude: true, skipPermissions: false })).json();
const aAuto = attach(auto.id);
await new Promise((r) => setTimeout(r, 3500));
check("auto-claude typed 'claude'", strip(aAuto.box.out).includes("claude"), strip(aAuto.box.out).slice(-120));
aAuto.ws.close();

await fetch(BASE + "/api/sessions", { method: "DELETE" });
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
