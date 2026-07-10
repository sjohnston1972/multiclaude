import {
  Actions,
  DockLocation,
  Model,
  TabNode,
  type IJsonModel,
  type IJsonTabNode,
  type Node,
} from "flexlayout-react";

/** flexlayout options applied to every layout we build. */
export const GLOBAL_LAYOUT_OPTS = {
  tabEnableRename: true,
  tabSetEnableMaximize: true,
  splitterSize: 6,
};

export interface SessionRef {
  id: string;
  title: string;
  cwd: string;
}

export function tabJson(s: SessionRef): IJsonTabNode {
  return {
    type: "tab",
    name: s.title,
    component: "terminal",
    config: { sessionId: s.id, cwd: s.cwd },
  };
}

function emptyLayout(): IJsonModel {
  return {
    global: GLOBAL_LAYOUT_OPTS,
    borders: [],
    layout: { type: "row", children: [{ type: "tabset", weight: 100, children: [] }] },
  };
}

function terminalTabSessionIds(model: Model): Set<string> {
  const ids = new Set<string>();
  model.visitNodes((n: Node) => {
    if (n.getType() === "tab" && (n as TabNode).getComponent() === "terminal") {
      const sid = (n as TabNode).getConfig()?.sessionId;
      if (sid) ids.add(sid);
    }
  });
  return ids;
}

function firstTabsetId(model: Model): string | undefined {
  let id: string | undefined;
  model.visitNodes((n: Node) => {
    if (!id && n.getType() === "tabset") id = n.getId();
  });
  return id;
}

export function countTerminalTabs(model: Model): number {
  let n = 0;
  model.visitNodes((node: Node) => {
    if (node.getType() === "tab" && (node as TabNode).getComponent() === "terminal") n++;
  });
  return n;
}

/**
 * Build the model to render on load by reconciling the saved layout against
 * the sessions the server actually holds. Every live session gets a tab, so a
 * refresh can never leave a running session "detached" with no pane. Returns
 * `needsDefault: true` when there is nothing to show at all (caller then spawns
 * one fresh session and adds it to `tabsetId`).
 */
export function reconcileLayout(
  saved: IJsonModel | null | undefined,
  live: SessionRef[]
): { model: Model; needsDefault: boolean; tabsetId?: string } {
  const model = Model.fromJson(saved ?? emptyLayout());
  const shown = terminalTabSessionIds(model);
  const tabsetId = firstTabsetId(model);

  for (const s of live) {
    if (!shown.has(s.id) && tabsetId) {
      model.doAction(Actions.addTab(tabJson(s), tabsetId, DockLocation.CENTER, -1, false));
    }
  }

  return { model, needsDefault: countTerminalTabs(model) === 0, tabsetId };
}
