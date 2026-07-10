import { useCallback, useEffect, useRef, useState } from "react";
import {
  Actions,
  DockLocation,
  Layout,
  Model,
  TabNode,
  type Action,
  type IJsonModel,
  type IJsonTabNode,
  type ILayoutApi,
  type ITabRenderValues,
} from "flexlayout-react";
import { api, AppSettings, AppState, SessionInfo } from "./api";
import TerminalPane from "./TerminalPane";
import SessionListModal from "./SessionListModal";
import NewSessionDialog from "./NewSessionDialog";
import SettingsModal from "./SettingsModal";
import HealthModal from "./HealthModal";
import { Button, Modal, ToolbarButton } from "./components";

const GLOBAL_LAYOUT_OPTS = {
  tabEnableRename: true,
  tabSetEnableMaximize: true,
  splitterSize: 6,
};

function tabJson(s: { id: string; title: string; cwd: string }): IJsonTabNode {
  return {
    type: "tab",
    name: s.title,
    component: "terminal",
    config: { sessionId: s.id, cwd: s.cwd },
  };
}

function singleTabLayout(tab: IJsonTabNode): IJsonModel {
  return {
    global: GLOBAL_LAYOUT_OPTS,
    borders: [],
    layout: { type: "row", children: [{ type: "tabset", weight: 100, children: [tab] }] },
  };
}

export default function App() {
  const [model, setModel] = useState<Model | null>(null);
  const [settings, setSettings] = useState<AppSettings>({ fontSize: 14, scrollback: 10000 });
  const [error, setError] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHealth, setShowHealth] = useState(false);
  const [dots, setDots] = useState<Record<string, boolean>>({});
  const lastSeenRef = useRef<Record<string, number>>({});
  const autoTitleRef = useRef<Record<string, string>>({});
  const loadTimeRef = useRef(Date.now());
  const [confirmClose, setConfirmClose] = useState<{
    tabId: string;
    sessionId: string;
    name: string;
  } | null>(null);
  const layoutRef = useRef<ILayoutApi | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ------------------------------------------------------------------ load
  useEffect(() => {
    (async () => {
      try {
        const state = await api<AppState>("/api/state");
        setSettings(state.settings);
        if (state.layout) {
          setModel(Model.fromJson(state.layout as IJsonModel));
        } else {
          const s = await api<SessionInfo>("/api/sessions", { method: "POST", body: {} });
          setModel(Model.fromJson(singleTabLayout(tabJson(s))));
        }
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  // ------------------------------------------------------------------ save
  const persistLayout = useCallback((m: Model) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api("/api/state", { method: "PUT", body: { layout: m.toJson() } }).catch(() => {
        /* server briefly down — next change retries */
      });
    }, 500);
  }, []);

  // ------------------------------------------------------------ tab helpers
  const collectTerminalTabs = useCallback((): TabNode[] => {
    const tabs: TabNode[] = [];
    model?.visitNodes((n) => {
      if (n.getType() === "tab" && (n as TabNode).getComponent() === "terminal") {
        tabs.push(n as TabNode);
      }
    });
    return tabs;
  }, [model]);

  const openSessionIds = new Set(
    collectTerminalTabs().map((t) => (t.getConfig() as { sessionId: string })?.sessionId)
  );

  const addSessionTab = useCallback(
    (s: { id: string; title: string; cwd: string }) => {
      if (!model) return;
      const json = tabJson(s);
      const added = layoutRef.current?.addTabToActiveTabSet(json);
      if (!added) {
        let tabsetId: string | undefined;
        model.visitNodes((n) => {
          if (!tabsetId && n.getType() === "tabset") tabsetId = n.getId();
        });
        if (tabsetId) model.doAction(Actions.addTab(json, tabsetId, DockLocation.CENTER, -1, true));
      }
      persistLayout(model);
    },
    [model, persistLayout]
  );

  // ------------------------------------------------- close tab confirmation
  const onAction = useCallback(
    (action: Action): Action | undefined => {
      if (action.type === Actions.DELETE_TAB && model) {
        const node = model.getNodeById(action.data.node as string) as TabNode | undefined;
        if (node?.getComponent() === "terminal") {
          setConfirmClose({
            tabId: node.getId(),
            sessionId: (node.getConfig() as { sessionId: string })?.sessionId,
            name: node.getName(),
          });
          return undefined; // veto — we delete it ourselves after the user picks
        }
      }
      return action;
    },
    [model]
  );

  const closeTab = useCallback(
    async (killSession: boolean) => {
      if (!confirmClose || !model) return;
      if (killSession) {
        try {
          await api(`/api/sessions/${encodeURIComponent(confirmClose.sessionId)}`, {
            method: "DELETE",
          });
        } catch {
          /* already dead is fine */
        }
      }
      // doAction bypasses onAction, so no confirmation loop.
      model.doAction(Actions.deleteTab(confirmClose.tabId));
      setConfirmClose(null);
      persistLayout(model);
    },
    [confirmClose, model, persistLayout]
  );

  // ---------------------------------------------------------------- presets
  const applyPreset = useCallback(
    async (count: 1 | 2 | 4) => {
      if (!model) return;
      try {
        const tabs: IJsonTabNode[] = collectTerminalTabs().map((t) => ({
          type: "tab",
          name: t.getName(),
          component: "terminal",
          config: t.getConfig(),
        }));
        while (tabs.length < count) {
          const s = await api<SessionInfo>("/api/sessions", { method: "POST", body: {} });
          tabs.push(tabJson(s));
        }
        const sets: IJsonTabNode[][] = Array.from({ length: count }, () => []);
        tabs.forEach((t, i) => sets[i % count].push(t));
        const tabset = (children: IJsonTabNode[]) => ({
          type: "tabset" as const,
          weight: 50,
          children,
        });
        let layout;
        if (count === 1) {
          layout = { type: "row" as const, children: [tabset(sets[0])] };
        } else if (count === 2) {
          layout = { type: "row" as const, children: [tabset(sets[0]), tabset(sets[1])] };
        } else {
          layout = {
            type: "row" as const,
            children: [
              { type: "row" as const, weight: 50, children: [tabset(sets[0]), tabset(sets[1])] },
              { type: "row" as const, weight: 50, children: [tabset(sets[2]), tabset(sets[3])] },
            ],
          };
        }
        const m = Model.fromJson({ global: GLOBAL_LAYOUT_OPTS, borders: [], layout });
        setModel(m);
        persistLayout(m);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [model, collectTerminalTabs, persistLayout]
  );

  // ------------------------------------------------------------ session list
  const reattach = useCallback(
    (s: SessionInfo) => {
      addSessionTab(s);
      setShowSessions(false);
    },
    [addSessionTab]
  );

  const killFromList = useCallback(
    async (s: SessionInfo) => {
      try {
        await api(`/api/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" });
        if (model) {
          const tab = collectTerminalTabs().find(
            (t) => (t.getConfig() as { sessionId: string })?.sessionId === s.id
          );
          if (tab) model.doAction(Actions.deleteTab(tab.getId()));
        }
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [model, collectTerminalTabs]
  );

  // ------------------------------------- title refresh + activity indicators
  useEffect(() => {
    if (!model) return;
    const tick = async () => {
      let list: SessionInfo[];
      try {
        list = await api<SessionInfo[]>("/api/sessions");
      } catch {
        return; // server briefly down — try again next tick
      }
      const byId = new Map(list.map((s) => [s.id, s]));
      const newDots: Record<string, boolean> = {};
      collectTerminalTabs().forEach((tab) => {
        const sid = (tab.getConfig() as { sessionId: string })?.sessionId;
        const s = sid ? byId.get(sid) : undefined;
        if (!s) return;

        if (tab.isVisible()) {
          // Seen right now — no dot.
          lastSeenRef.current[sid] = Date.now();
        } else if (s.lastOutputAt > (lastSeenRef.current[sid] ?? loadTimeRef.current)) {
          // Background session produced output since we last looked at it.
          newDots[sid] = true;
        }

        // Keep tab titles in sync with folder + git branch, but never clobber
        // a name the user typed themselves (rename via double-click).
        autoTitleRef.current[sid] ??= tab.getName();
        if (tab.getName() === autoTitleRef.current[sid] && s.title !== tab.getName()) {
          model.doAction(Actions.renameTab(tab.getId(), s.title));
          autoTitleRef.current[sid] = s.title;
        }
      });
      setDots(newDots);
    };
    void tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [model, collectTerminalTabs]);

  const onRenderTab = useCallback(
    (tabNode: TabNode, rv: ITabRenderValues) => {
      const sid = (tabNode.getConfig() as { sessionId?: string })?.sessionId;
      if (sid && dots[sid]) {
        rv.leading = (
          <span
            className="inline-block h-2 w-2 rounded-full bg-emerald-400"
            title="New output since you last looked"
          />
        );
      }
    },
    [dots]
  );

  // ------------------------------------------------------ keyboard shortcuts
  const cycleTab = useCallback(
    (dir: 1 | -1) => {
      if (!model) return;
      const tabs = collectTerminalTabs();
      if (tabs.length < 2) return;
      const active = model.getActiveTabset()?.getSelectedNode() as TabNode | undefined;
      const idx = active ? tabs.findIndex((t) => t.getId() === active.getId()) : -1;
      const next = tabs[(idx + dir + tabs.length) % tabs.length];
      model.doAction(Actions.selectTab(next.getId()));
      const parent = next.getParent();
      if (parent) model.doAction(Actions.setActiveTabset(parent.getId()));
    },
    [model, collectTerminalTabs]
  );

  useEffect(() => {
    // Note: some browsers reserve Ctrl+Tab / Ctrl+Shift+T for themselves and
    // never let a page see them — these work where the browser allows it.
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        setShowNew(true);
      } else if (e.ctrlKey && e.code === "Tab") {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cycleTab]);

  // ---------------------------------------------------------------- factory
  const factory = useCallback(
    (node: TabNode) => {
      if (node.getComponent() === "terminal") {
        const cfg = (node.getConfig() ?? {}) as { sessionId: string; cwd?: string };
        return (
          <TerminalPane
            sessionId={cfg.sessionId}
            cwd={cfg.cwd}
            node={node}
            fontSize={settings.fontSize}
            scrollback={settings.scrollback}
          />
        );
      }
      return null;
    },
    [settings]
  );

  // ------------------------------------------------------------------ toast
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(t);
  }, [error]);

  if (!model) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 text-neutral-400">
        {error ? <span className="text-red-400">{error}</span> : "Starting…"}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-neutral-800 px-2">
        <span className="mr-2 select-none text-sm font-semibold text-neutral-100">
          multi<span className="text-orange-400">claude</span>
        </span>
        <ToolbarButton onClick={() => setShowNew(true)} title="Open a new terminal session">
          ＋ New session
        </ToolbarButton>
        <ToolbarButton onClick={() => setShowSessions(true)} title="All live sessions">
          Sessions
        </ToolbarButton>
        <div className="mx-2 h-5 w-px bg-neutral-700" />
        <span className="text-xs text-neutral-500">Layout:</span>
        <ToolbarButton onClick={() => void applyPreset(1)} title="Single pane">
          Single
        </ToolbarButton>
        <ToolbarButton onClick={() => void applyPreset(2)} title="Two panes side by side">
          2-up
        </ToolbarButton>
        <ToolbarButton onClick={() => void applyPreset(4)} title="Four panes in a grid">
          2×2
        </ToolbarButton>
        <div className="ml-auto flex items-center gap-1">
          <ToolbarButton onClick={() => setShowHealth(true)} title="Server and session health">
            Health
          </ToolbarButton>
          <ToolbarButton onClick={() => setShowSettings(true)} title="Font size and scrollback">
            Settings
          </ToolbarButton>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <Layout
          ref={layoutRef}
          model={model}
          factory={factory}
          onAction={onAction}
          onRenderTab={onRenderTab}
          onModelChange={(m, action) => {
            if (action.type === Actions.SELECT_TAB) {
              // Selecting a tab counts as "seen" — clear its dot immediately.
              const node = m.getNodeById(action.data.node as string) as TabNode | undefined;
              const sid = (node?.getConfig() as { sessionId?: string })?.sessionId;
              if (sid) {
                lastSeenRef.current[sid] = Date.now();
                setDots((d) => (d[sid] ? { ...d, [sid]: false } : d));
              }
            }
            persistLayout(m);
          }}
        />
      </div>

      {showNew && (
        <NewSessionDialog
          onCreated={addSessionTab}
          onClose={() => setShowNew(false)}
        />
      )}

      {showSessions && (
        <SessionListModal
          openSessionIds={openSessionIds}
          onReattach={reattach}
          onKill={killFromList}
          onClose={() => setShowSessions(false)}
        />
      )}

      {showSettings && (
        <SettingsModal
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSave={(s) => {
            setSettings(s);
            api("/api/state", { method: "PUT", body: { settings: s } }).catch((e) =>
              setError((e as Error).message)
            );
          }}
        />
      )}

      {showHealth && <HealthModal onClose={() => setShowHealth(false)} />}

      {confirmClose && (
        <Modal title={`Close "${confirmClose.name}"`} onClose={() => setConfirmClose(null)}>
          <p className="mb-4 text-neutral-300">
            Kill the session, or keep it running in the background? Background sessions stay alive
            on the server and can be reattached from the Sessions list.
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirmClose(null)}>Cancel</Button>
            <Button onClick={() => void closeTab(false)}>Keep running</Button>
            <Button kind="danger" onClick={() => void closeTab(true)}>
              Kill session
            </Button>
          </div>
        </Modal>
      )}

      {error && (
        <div className="absolute bottom-3 right-3 z-50 max-w-md rounded border border-red-800 bg-red-950 px-4 py-2 text-sm text-red-200 shadow-lg">
          {error}
        </div>
      )}
    </div>
  );
}
