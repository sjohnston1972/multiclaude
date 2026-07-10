// Verifies layout reconciliation: every live session gets a tab on load, no
// duplicates, and a fresh default is requested only when there's nothing at all.
// Run with: npx tsx scripts/reconcile-test.ts

// Minimal DOM stub — flexlayout's TabNode builds a detached <div> on creation.
const fakeEl: any = new Proxy(
  {},
  { get: (_t, p) => (p === "style" ? {} : () => fakeEl), set: () => true }
);
(globalThis as any).document = { createElement: () => fakeEl, createElementNS: () => fakeEl };
(globalThis as any).window = { addEventListener() {}, removeEventListener() {} };

import { reconcileLayout, tabJson, countTerminalTabs, GLOBAL_LAYOUT_OPTS } from "../web/src/layoutReconcile";
import { Model, TabNode, type IJsonModel } from "flexlayout-react";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " " + extra}`);
  if (!cond) failures++;
};
const S = (id: string) => ({ id, title: id, cwd: "C:\\x" });
const ids = (m: Model): string[] => {
  const out: string[] = [];
  m.visitNodes((n) => {
    if (n.getType() === "tab" && (n as TabNode).getComponent() === "terminal") {
      out.push((n as TabNode).getConfig()?.sessionId);
    }
  });
  return out.sort();
};
const layoutWith = (...tabIds: string[]): IJsonModel => ({
  global: GLOBAL_LAYOUT_OPTS,
  borders: [],
  layout: { type: "row", children: [{ type: "tabset", weight: 100, children: tabIds.map((i) => tabJson(S(i))) }] },
});
const emptySaved: IJsonModel = {
  global: GLOBAL_LAYOUT_OPTS,
  borders: [],
  layout: { type: "row", children: [{ type: "tabset", weight: 100, children: [] }] },
};

// 1. No saved layout, no sessions → needs a default.
let r = reconcileLayout(null, []);
check("null layout + no sessions -> needsDefault", r.needsDefault && countTerminalTabs(r.model) === 0);

// 2. No saved layout, 2 live sessions → both re-surfaced, no default.
r = reconcileLayout(null, [S("a"), S("b")]);
check("null layout + 2 sessions -> 2 tabs", !r.needsDefault && ids(r.model).join() === "a,b", ids(r.model).join());

// 3. THE BUG: empty saved tabset + 1 live session → session re-surfaced (not stranded).
r = reconcileLayout(emptySaved, [S("live1")]);
check("empty layout + live session -> tab re-surfaced", !r.needsDefault && ids(r.model).join() === "live1", ids(r.model).join());

// 4. Empty saved + no sessions → needs default.
r = reconcileLayout(emptySaved, []);
check("empty layout + no sessions -> needsDefault", r.needsDefault);

// 5. Saved layout already shows the session → no duplicate.
r = reconcileLayout(layoutWith("a"), [S("a")]);
check("saved tab + same live session -> no dup", ids(r.model).join() === "a", ids(r.model).join());

// 6. Saved shows A, but B is also live in background → B added, A kept.
r = reconcileLayout(layoutWith("a"), [S("a"), S("b")]);
check("saved tab A + live A,B -> A,B shown", ids(r.model).join() === "a,b", ids(r.model).join());

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
