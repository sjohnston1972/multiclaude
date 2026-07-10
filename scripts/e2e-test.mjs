import WebSocket from "ws";

// Simulates what the browser does: attach, resize, type a command, read output.
// Then attaches a SECOND connection to verify scrollback replay (reattach).

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:3001/ws?session=default");
    let output = "";
    ws.on("open", () => ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "output") output += msg.data;
    });
    ws.on("error", reject);
    setTimeout(() => resolve({ ws, get output() { return output; } }), 1000);
  });
}

const first = await connect("first");
first.ws.send(JSON.stringify({ type: "input", data: "echo ('e2e-' + (7*6))\r" }));
await new Promise((r) => setTimeout(r, 4000));

const test1 = first.output.includes("e2e-42");
console.log("TEST 1 live output:", test1 ? "PASS" : "FAIL");
first.ws.close();

// New connection — server should replay scrollback containing the old output.
const second = await connect("second");
await new Promise((r) => setTimeout(r, 1500));
const test2 = second.output.includes("e2e-42");
console.log("TEST 2 scrollback replay on reattach:", test2 ? "PASS" : "FAIL");
second.ws.close();

if (!test1) console.log("--- first output ---\n" + first.output.slice(-2000));
if (!test2) console.log("--- second output ---\n" + second.output.slice(-2000));
process.exit(test1 && test2 ? 0 : 1);
