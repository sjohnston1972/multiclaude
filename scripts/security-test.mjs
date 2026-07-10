// Verifies cross-origin defence: loopback/no-origin allowed, foreign origin rejected.
import WebSocket from "ws";
const BASE = "http://127.0.0.1:3001";
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " " + extra}`);
  if (!cond) failures++;
};

// --- REST: foreign Origin rejected, no-Origin allowed, loopback Origin allowed
const evil = await fetch(`${BASE}/api/health`, { headers: { origin: "http://evil.com" } });
check("REST rejects foreign origin", evil.status === 403, `status ${evil.status}`);

const noOrigin = await fetch(`${BASE}/api/health`);
check("REST allows no origin (CLI)", noOrigin.ok);

const loopback = await fetch(`${BASE}/api/health`, { headers: { origin: "http://127.0.0.1:5173" } });
check("REST allows loopback origin", loopback.ok);

// --- WS: foreign Origin rejected
function tryWs(headers, label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:3001/ws?session=sec-${label}`, { headers });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve(ok);
    };
    ws.on("open", () => done("open"));
    ws.on("error", () => done("error"));
    ws.on("unexpected-response", () => done("rejected"));
    setTimeout(() => done("timeout"), 3000);
  });
}

const evilWs = await tryWs({ origin: "http://evil.com" }, "evil");
check("WS rejects foreign origin", evilWs !== "open", `got ${evilWs}`);

const okWs = await tryWs({ origin: "http://127.0.0.1:5173" }, "good");
check("WS allows loopback origin", okWs === "open", `got ${okWs}`);

const cliWs = await tryWs({}, "cli");
check("WS allows no origin (CLI)", cliWs === "open", `got ${cliWs}`);

// clean up any sessions spawned by the allowed WS connections
await fetch(`${BASE}/api/sessions`, { method: "DELETE" });

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
