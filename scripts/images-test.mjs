// Tests the image upload endpoint: PNG accepted and saved, junk rejected.
import fs from "node:fs";
const BASE = "http://127.0.0.1:3001";
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " " + extra}`);
  if (!cond) failures++;
};

// Minimal valid 1x1 transparent PNG
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const up = await fetch(`${BASE}/api/images`, {
  method: "POST",
  headers: { "content-type": "image/png" },
  body: png,
});
const j = await up.json();
check("png accepted", up.ok && typeof j.path === "string", JSON.stringify(j));
check("file exists on disk", j.path && fs.existsSync(j.path));
check("saved in images dir", j.path?.includes("multiclaude\\images"));

const bad = await fetch(`${BASE}/api/images`, {
  method: "POST",
  headers: { "content-type": "application/x-msdownload" },
  body: Buffer.from("MZ...not an image"),
});
check("non-image rejected", bad.status === 415, `status ${bad.status}`);

// clean up the test image
if (j.path) fs.unlinkSync(j.path);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
