import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  GLOBAL_LAYOUT_OPTS,
  countRenderableTabs,
  countTerminalTabs,
  reconcileLayout,
  tabJson,
} from "./layoutReconcile";
import TerminalPane from "./TerminalPane";
import AutonomousTab from "./AutonomousTab";
import AutonomousNewDialog, { type LaunchedTab } from "./AutonomousNewDialog";
import SessionListModal from "./SessionListModal";
import NewSessionDialog from "./NewSessionDialog";
import SettingsModal from "./SettingsModal";
import HealthModal from "./HealthModal";
import BroadcastModal from "./BroadcastModal";
import RestoreModal, { type RestorableSpec } from "./RestoreModal";
import CommandPalette, { type Command } from "./CommandPalette";
import Hero from "./Hero";
import FolderPickerModal from "./FolderPickerModal";
import { updateFavicon } from "./favicon";
import { notify } from "./notifications";
import { Button, Modal, ToolbarButton } from "./components";

export default function App() {
  const [model, setModel] = useState<Model | null>(null);
  const [settings, setSettings] = useState<AppSettings>({ fontSize: 14, scrollback: 10000 });
  const [error, setError] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showAutonomous, setShowAutonomous] = useState(false);
  const [autonomousDir, setAutonomousDir] = useState(""); // last project used, to pre-fill pre-flight
  const [showSettings, setShowSettings] = useState(false);
  const [showHealth, setShowHealth] = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [liveSessions, setLiveSessions] = useState<SessionInfo[]>([]);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string; sessionId: string } | null>(null);
  const [pickFolderFor, setPickFolderFor] = useState<{ tabId: string; sessionId: string } | null>(null);
  const [lan, setLan] = useState<{ lan: boolean; lanUrls: string[] } | null>(null);
  const [dots, setDots] = useState<Record<string, boolean>>({});
  const lastSeenRef = useRef<Record<string, number>>({});
  const autoTitleRef = useRef<Record<string, string>>({});
  const loadTimeRef = useRef(Date.now());
  const sessionTitlesRef = useRef<Record<string, string>>({});
  const notifiedRef = useRef<Set<string>>(new Set());
  const [confirmClose, setConfirmClose] = useState<{
    tabId: string;
    sessionId: string;
    name: string;
  } | null>(null);
  const [restorable, setRestorable] = useState<RestorableSpec[] | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [tabCount, setTabCount] = useState(0);
  const pendingLayoutRef = useRef<unknown | null>(null);
  const layoutRef = useRef<ILayoutApi | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLoad = useRef(false);

  // ------------------------------------------------------------------ load
  // Reconcile the saved layout against the sessions the server actually holds:
  // every live session must get a tab, so a refresh can never leave a running
  // session "detached" with no pane — even if the saved layout is empty or
  // stale. Only when there are genuinely no sessions and no tabs do we spawn a
  // fresh default one.
  // Build the model from a (possibly null) saved layout, reconciling against
  // the sessions the server currently holds. No default session is created —
  // an empty model shows the home screen (Hero) instead.
  const buildModel = useCallback(async (layout: unknown | null) => {
    const live = await api<SessionInfo[]>("/api/sessions").catch(() => []);
    const { model: m } = reconcileLayout(layout as IJsonModel | null, live);
    setModel(m);
    setTabCount(countRenderableTabs(m));
    api("/api/state", { method: "PUT", body: { layout: m.toJson() } }).catch(() => {});
  }, []);

  useEffect(() => {
    if (didLoad.current) return; // guard React 18 StrictMode double-invoke in dev
    didLoad.current = true;
    (async () => {
      try {
        const state = await api<AppState>("/api/state");
        setSettings(state.settings);
        // If the server was restarted, there are sessions to offer back — ask
        // before respawning anything, and don't render the stale layout yet.
        const specs = await api<RestorableSpec[]>("/api/sessions/restorable").catch(() => []);
        if (specs.length > 0) {
          pendingLayoutRef.current = state.layout ?? null;
          setRestorable(specs);
          return;
        }
        await buildModel(state.layout ?? null);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [buildModel]);

  const doRestore = useCallback(async () => {
    setRestoreBusy(true);
    try {
      // Respawns the sessions with their original ids, so the saved layout
      // re-attaches to them exactly as it was.
      await api("/api/sessions/restore", { method: "POST" });
      setRestorable(null);
      await buildModel(pendingLayoutRef.current);
    } catch (e) {
      setError((e as Error).message);
      setRestoreBusy(false);
    }
  }, [buildModel]);

  const doStartFresh = useCallback(async () => {
    setRestoreBusy(true);
    try {
      await api("/api/sessions/restore/dismiss", { method: "POST" });
      setRestorable(null);
      await buildModel(null); // discard the old layout; open one fresh session
    } catch (e) {
      setError((e as Error).message);
      setRestoreBusy(false);
    }
  }, [buildModel]);

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

  // Open a session in a specific folder (home-screen tile) — starts claude,
  // matching the New Session dialog's defaults, for a one-click resume.
  const openFolderSession = useCallback(
    async (cwd: string) => {
      try {
        const s = await api<SessionInfo>("/api/sessions", {
          method: "POST",
          body: { cwd, autoClaude: true, skipPermissions: true },
        });
        addSessionTab(s);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [addSessionTab]
  );

  // Add an Autonomous tab (component:"autonomous") to the active tabset.
  const addAutonomousTab = useCallback(
    (t: LaunchedTab) => {
      if (!model) return;
      const json = {
        type: "tab" as const,
        name: `⚙ ${t.taskName}`,
        component: "autonomous",
        config: { tabId: t.id, taskName: t.taskName },
      };
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

  const openBlankShell = useCallback(async () => {
    try {
      const s = await api<SessionInfo>("/api/sessions", { method: "POST", body: {} });
      addSessionTab(s);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [addSessionTab]);

  // Right-click a tab → browse to a folder: cd the shell there and rename the
  // tab to the folder (the server also updates the tracked cwd + branch).
  const changeTabFolder = useCallback(
    async (tabId: string, sessionId: string, folder: string) => {
      try {
        const info = await api<SessionInfo>(`/api/sessions/${encodeURIComponent(sessionId)}/cd`, {
          method: "POST",
          body: { path: folder },
        });
        if (model) {
          model.doAction(Actions.renameTab(tabId, info.title));
          // Let the auto-title refresh keep this name (don't treat it as a manual rename).
          autoTitleRef.current[sessionId] = info.title;
          persistLayout(model);
        }
      } catch (e) {
        setError((e as Error).message);
      }
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
        // Fire and forget — the tab should close instantly; the server takes
        // ~1s to Ctrl-C and reap the process in the background.
        api(`/api/sessions/${encodeURIComponent(confirmClose.sessionId)}`, {
          method: "DELETE",
        }).catch(() => {
          /* already dead is fine */
        });
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
    async (count: 1 | 2 | 4 | 9) => {
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
          // Square grids (2×2, 3×3): one inner row per grid row.
          const side = Math.sqrt(count);
          layout = {
            type: "row" as const,
            children: Array.from({ length: side }, (_, r) => ({
              type: "row" as const,
              weight: 100 / side,
              children: sets.slice(r * side, (r + 1) * side).map(tabset),
            })),
          };
        }
        const m = Model.fromJson({ global: GLOBAL_LAYOUT_OPTS, borders: [], layout });
        setModel(m);
        setTabCount(countRenderableTabs(m));
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

  const duplicateFromList = useCallback(
    async (s: SessionInfo) => {
      try {
        const dup = await api<SessionInfo>("/api/sessions", {
          method: "POST",
          body: { cwd: s.cwd },
        });
        addSessionTab(dup);
        setShowSessions(false);
      } catch (e) {
        setError((e as Error).message);
      }
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
      setLiveSessions(list);
      const byId = new Map(list.map((s) => [s.id, s]));
      const newDots: Record<string, boolean> = {};
      collectTerminalTabs().forEach((tab) => {
        const sid = (tab.getConfig() as { sessionId: string })?.sessionId;
        const s = sid ? byId.get(sid) : undefined;
        if (!s) return;
        sessionTitlesRef.current[sid] = tab.getName() || s.title;

        if (tab.isVisible()) {
          // Seen right now — no dot.
          lastSeenRef.current[sid] = Date.now();
        } else if (s.lastBellAt > (lastSeenRef.current[sid] ?? loadTimeRef.current)) {
          // Background session rang the terminal bell since we last looked —
          // that's claude (or any CLI) asking for attention, e.g. "done".
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

  // ----------------------------------------- attention routing (title/favicon)
  // Whenever the set of sessions wanting attention changes: reflect the count
  // in the browser tab title and favicon badge, and fire a one-shot desktop
  // notification for each session that has newly started asking for attention.
  useEffect(() => {
    const attentionIds = Object.keys(dots).filter((id) => dots[id]);
    const count = attentionIds.length;

    document.title = count > 0 ? `(${count}) multiclaude` : "multiclaude";
    updateFavicon(count);

    for (const id of attentionIds) {
      if (!notifiedRef.current.has(id)) {
        notifiedRef.current.add(id);
        const name = sessionTitlesRef.current[id] ?? "A session";
        notify("multiclaude", `${name} wants your attention`);
      }
    }
    // Allow a session to notify again next time it goes quiet then rings.
    for (const id of [...notifiedRef.current]) {
      if (!dots[id]) notifiedRef.current.delete(id);
    }
  }, [dots]);

  const attentionIds = new Set(Object.keys(dots).filter((id) => dots[id]));

  // ------------------------------------------------------ keyboard shortcuts
  const selectTab = useCallback(
    (tabId: string) => {
      if (!model) return;
      const node = model.getNodeById(tabId) as TabNode | undefined;
      model.doAction(Actions.selectTab(tabId));
      const parent = node?.getParent();
      if (parent) model.doAction(Actions.setActiveTabset(parent.getId()));
    },
    [model]
  );

  const cycleTab = useCallback(
    (dir: 1 | -1) => {
      if (!model) return;
      const tabs = collectTerminalTabs();
      if (tabs.length < 2) return;
      const active = model.getActiveTabset()?.getSelectedNode() as TabNode | undefined;
      const idx = active ? tabs.findIndex((t) => t.getId() === active.getId()) : -1;
      selectTab(tabs[(idx + dir + tabs.length) % tabs.length].getId());
    },
    [model, collectTerminalTabs, selectTab]
  );

  const killAllFromList = useCallback(async () => {
    try {
      await api("/api/sessions", { method: "DELETE" });
      if (model) {
        collectTerminalTabs().forEach((t) => model.doAction(Actions.deleteTab(t.getId())));
        persistLayout(model);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [model, collectTerminalTabs, persistLayout]);

  // Full command list for the Ctrl-K palette: jump to any pane, reattach a
  // background session, or run any action.
  const paletteCommands = useMemo((): Command[] => {
    const cmds: Command[] = [];
    const tabs = collectTerminalTabs();
    const shown = new Set(
      tabs.map((t) => (t.getConfig() as { sessionId?: string })?.sessionId)
    );
    tabs.forEach((t) => {
      const cfg = (t.getConfig() ?? {}) as { sessionId?: string; cwd?: string };
      cmds.push({
        id: `tab:${t.getId()}`,
        title: `Go to ${t.getName()}`,
        subtitle: cfg.cwd,
        group: "Sessions",
        run: () => selectTab(t.getId()),
      });
    });
    liveSessions
      .filter((s) => !shown.has(s.id))
      .forEach((s) => {
        cmds.push({
          id: `bg:${s.id}`,
          title: `Reattach ${s.title}`,
          subtitle: s.cwd,
          group: "Background sessions",
          run: () => reattach(s),
        });
      });
    cmds.push({ id: "a:new", title: "New session…", group: "Actions", run: () => setShowNew(true) });
    cmds.push({ id: "a:bcast", title: "Broadcast to all…", group: "Actions", run: () => setShowBroadcast(true) });
    cmds.push({ id: "a:sessions", title: "Sessions list…", group: "Actions", run: () => setShowSessions(true) });
    cmds.push({ id: "a:health", title: "Health", group: "Actions", run: () => setShowHealth(true) });
    cmds.push({ id: "a:settings", title: "Settings", group: "Actions", run: () => setShowSettings(true) });
    cmds.push({ id: "l:1", title: "Layout: Single", group: "Layout", run: () => void applyPreset(1) });
    cmds.push({ id: "l:2", title: "Layout: 2-up", group: "Layout", run: () => void applyPreset(2) });
    cmds.push({ id: "l:4", title: "Layout: 2×2", group: "Layout", run: () => void applyPreset(4) });
    cmds.push({ id: "l:9", title: "Layout: 3×3", group: "Layout", run: () => void applyPreset(9) });
    cmds.push({
      id: "d:killall",
      title: "Kill all sessions",
      group: "Danger",
      danger: true,
      run: () => void killAllFromList(),
    });
    return cmds;
  }, [collectTerminalTabs, liveSessions, selectTab, reattach, applyPreset, killAllFromList]);

  useEffect(() => {
    // Note: some browsers reserve Ctrl+Tab / Ctrl+Shift+T for themselves and
    // never let a page see them — these work where the browser allows it.
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyK") {
        // Intercept before the terminal sees it, and toggle the palette.
        e.preventDefault();
        e.stopPropagation();
        setShowPalette((p) => !p);
      } else if (e.ctrlKey && e.shiftKey && e.code === "KeyT") {
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
      if (node.getComponent() === "autonomous") {
        const cfg = (node.getConfig() ?? {}) as { tabId: string; taskName?: string };
        return <AutonomousTab tabId={cfg.tabId} taskName={cfg.taskName} node={node} />;
      }
      return null;
    },
    [settings]
  );

  // --------------------------------------------------------- LAN status once
  useEffect(() => {
    api<{ lan: boolean; lanUrls: string[] }>("/api/health")
      .then((h) => setLan({ lan: h.lan, lanUrls: h.lanUrls }))
      .catch(() => {});
  }, []);

  // ------------------------------------------------------------------ toast
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(t);
  }, [error]);

  if (!model) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 text-neutral-400">
        {restorable ? (
          <RestoreModal
            specs={restorable}
            busy={restoreBusy}
            onRestore={() => void doRestore()}
            onStartFresh={() => void doStartFresh()}
          />
        ) : error ? (
          <span className="text-red-400">{error}</span>
        ) : (
          "Starting…"
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-neutral-800 px-2">
        <span className="mr-2 select-none text-sm font-semibold text-neutral-100">
          multi<span className="text-orange-400">claude</span>
        </span>
        {lan?.lan && (
          <span
            onClick={() => setShowHealth(true)}
            title={
              "This server is exposed to your LAN — anyone who can reach it gets a shell on this PC.\n\nReachable at:\n" +
              (lan.lanUrls.join("\n") || "(your LAN addresses)")
            }
            className="mr-2 flex cursor-pointer items-center gap-1 rounded border border-amber-600/60 bg-amber-950/60 px-2 py-0.5 text-xs font-medium text-amber-300 hover:bg-amber-900/60"
          >
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
            LAN exposed
          </span>
        )}
        <ToolbarButton onClick={() => setShowNew(true)} title="Open a new terminal session">
          ＋ New session
        </ToolbarButton>
        <ToolbarButton
          onClick={() => setShowAutonomous(true)}
          title="Autonomous run — pre-flight & launch (re-opens pre-filled with your last project)"
        >
          ⚙ Autonomous
        </ToolbarButton>
        <ToolbarButton onClick={() => setShowSessions(true)} title="All live sessions">
          Sessions
        </ToolbarButton>
        <ToolbarButton
          onClick={() => setShowBroadcast(true)}
          title="Send a command to every session at once"
        >
          Broadcast
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
        <ToolbarButton onClick={() => void applyPreset(9)} title="Nine panes in a grid">
          3×3
        </ToolbarButton>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setShowPalette(true)}
            title="Command palette — jump to a session or run a command"
            className="mr-1 flex items-center gap-1.5 rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-700 hover:text-white"
          >
            <span>Search</span>
            <kbd className="rounded bg-neutral-800 px-1 font-mono text-[10px] text-neutral-400">Ctrl K</kbd>
          </button>
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
          onContextMenu={(node, event) => {
            if (node.getType() === "tab" && (node as TabNode).getComponent() === "terminal") {
              event.preventDefault();
              const sid = ((node as TabNode).getConfig() as { sessionId?: string })?.sessionId;
              if (sid) {
                setTabMenu({ x: event.clientX, y: event.clientY, tabId: node.getId(), sessionId: sid });
              }
            }
          }}
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
            setTabCount(countRenderableTabs(m));
            persistLayout(m);
          }}
        />
        {/* Home screen: shown over the (empty) layout whenever nothing's open. */}
        {tabCount === 0 && (
          <div className="absolute inset-0">
            <Hero
              onOpenFolder={(cwd) => void openFolderSession(cwd)}
              onNewSession={() => setShowNew(true)}
              onBlankShell={() => void openBlankShell()}
            />
          </div>
        )}
      </div>

      {showNew && (
        <NewSessionDialog
          onCreated={addSessionTab}
          onClose={() => setShowNew(false)}
          onAutonomous={() => {
            setShowNew(false);
            setShowAutonomous(true);
          }}
        />
      )}

      {showAutonomous && (
        <AutonomousNewDialog
          onLaunched={addAutonomousTab}
          onDraftPlan={(s) => {
            addSessionTab(s); // a normal terminal tab running primed claude
            setAutonomousDir(s.cwd ?? ""); // remember it so the top-bar button reopens here
            setShowAutonomous(false);
          }}
          initialProjectDir={autonomousDir}
          onClose={() => setShowAutonomous(false)}
        />
      )}

      {showSessions && (
        <SessionListModal
          openSessionIds={openSessionIds}
          attentionIds={attentionIds}
          onReattach={reattach}
          onKill={killFromList}
          onKillAll={killAllFromList}
          onDuplicate={duplicateFromList}
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

      {showBroadcast && <BroadcastModal onClose={() => setShowBroadcast(false)} />}

      {showPalette && (
        <CommandPalette commands={paletteCommands} onClose={() => setShowPalette(false)} />
      )}

      {/* Right-click tab menu */}
      {tabMenu && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setTabMenu(null)} />
          <div
            className="fixed z-50 min-w-[180px] overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 py-1 shadow-xl"
            style={{ left: tabMenu.x, top: tabMenu.y }}
          >
            <button
              onClick={() => {
                setPickFolderFor({ tabId: tabMenu.tabId, sessionId: tabMenu.sessionId });
                setTabMenu(null);
              }}
              className="block w-full px-3 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-700"
            >
              Browse to folder…
            </button>
          </div>
        </>
      )}

      {pickFolderFor && (
        <FolderPickerModal
          title="Browse to folder — the shell will cd there"
          onClose={() => setPickFolderFor(null)}
          onPick={(folder) => {
            void changeTabFolder(pickFolderFor.tabId, pickFolderFor.sessionId, folder);
            setPickFolderFor(null);
          }}
        />
      )}

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
