import { scopeThreadRef, scopedThreadKey } from "@threadlines/client-runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@threadlines/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import {
  selectActiveTab,
  selectThreadAgentState,
  selectThreadBrowserState,
  subscribePreviewWebviews,
  useBrowserPanelStore,
} from "../../browserPanelStore";
import {
  selectThreadPageStates,
  useBrowserLiveStore,
  type LiveThreadBrowser as LiveThreadBrowserRecord,
} from "../../browserLiveStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import { readEnvironmentApi, useEnvironmentApiAvailable } from "../../environmentApi";
import { usePrimaryEnvironmentDescriptor } from "../../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime/catalog";
import { useSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { useBrowserProfilePartition } from "../../lib/browserProfiles";
import { useStore } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { POINTER_RETIRE_MS, type AgentPointerPosition } from "./AgentPointer";
import { resolveBrowserSiteAccess } from "@threadlines/shared/preview";
import { pushNavigationPolicy } from "./browserApprovals";
import { nextBrowserApprovalId } from "./browserApprovalRequests";
import { installBrowserFocusGuard } from "./browserFocusGuard";
import {
  forgetThreadPages,
  hasBackgroundPages,
  notePageHidden,
  notePageShown,
  runBrowserLifecycleCheck,
} from "./browserLifecycle";
import { connectEnvironmentBrowserHost } from "./previewAutomationHost";
import { PreviewTabFrame, type PreviewFrameMode } from "./PreviewTabFrame";
import {
  attachedThreadGuests,
  prepareThreadBrowser,
  resolveThreadBrowserTarget,
  setBrowserThreadOpener,
} from "./threadBrowserAutomation";

/**
 * Where every thread's browser pages live.
 *
 * A `<webview>` loses its page when it leaves the DOM, so pages cannot live in
 * a thread's panel: switching threads, or opening Settings, would close them,
 * and an agent working in a thread you are not looking at would have no page
 * at all. They live here instead, at the root of the app, and never move.
 *
 * The thread on screen has its pages drawn exactly over its panel's page area
 * (the slot), by CSS anchor positioning, so they follow the panel through
 * resizes, splits and moves with no measuring. Every other running page sits
 * underneath the app, out of sight: painted while an agent is using it,
 * hidden once idle, frozen later, closed when memory runs short (see
 * `browserLifecyclePlan.ts`).
 *
 * The layer also holds this client's browser connection to each environment,
 * so agent requests reach a thread whichever thread is on screen.
 *
 * Desktop only: the web build has no `<webview>`.
 */
export const BROWSER_SLOT_ANCHOR = "--threadlines-browser-slot";

/** Hidden pages keep the size the panel last had, or this before it has had one. */
const DEFAULT_HIDDEN_PAGE_SIZE = { width: 1280, height: 800 };

/** How often idle pages are looked at, while there are any off screen. */
const LIFECYCLE_CHECK_INTERVAL_MS = 15_000;

/** This client's host id per environment, for claiming a thread's browser. */
const hostByEnvironment = new Map<string, { hostId: string; clientHosts: boolean }>();

/**
 * Tells the environment the user opened this thread's browser here, so its
 * agent requests come to this client (and its pages) from now on.
 */
export function claimThreadBrowser(threadRef: ScopedThreadRef): void {
  const host = hostByEnvironment.get(threadRef.environmentId);
  if (host === undefined || !host.clientHosts) return;
  // A connection being rebuilt is gone a moment before its host entry is.
  // Skipping loses nothing: the host that replaces this one claims the thread
  // on screen as it connects.
  void readEnvironmentApi(threadRef.environmentId)
    ?.previewAutomation.claim({ hostId: host.hostId, threadId: threadRef.threadId })
    .catch(() => undefined);
}

/** Closes a thread's running browser: its pages end, its tabs stay. */
export function closeThreadBrowser(threadRef: ScopedThreadRef): void {
  useBrowserLiveStore.getState().closeLive(threadRef);
  forgetThreadPages(threadRef);
}

interface ConnectedEnvironment {
  readonly environmentId: EnvironmentId;
  readonly machineLocal: boolean;
  readonly clientHosts: boolean;
}

/** This device's server and every connected saved computer, with what each can do. */
function useConnectedEnvironments(): ReadonlyArray<ConnectedEnvironment> {
  const primary = usePrimaryEnvironmentDescriptor();
  const saved = useSavedEnvironmentRuntimeStore((state) => state.byId);
  return useMemo(() => {
    const environments: ConnectedEnvironment[] = [];
    if (primary !== null) {
      environments.push({
        environmentId: primary.environmentId,
        // The desktop's own server: the same machine, so the same localhost.
        machineLocal: true,
        clientHosts: primary.capabilities.browserClientHosts === true,
      });
    }
    for (const [environmentId, runtime] of Object.entries(saved)) {
      if (environmentId === primary?.environmentId) continue;
      if (runtime.connectionState !== "connected" || runtime.descriptor === null) continue;
      environments.push({
        environmentId: environmentId as EnvironmentId,
        machineLocal: false,
        clientHosts: runtime.descriptor.capabilities.browserClientHosts === true,
      });
    }
    return environments;
  }, [primary, saved]);
}

/**
 * This client's browser connection to one environment, held while the
 * environment can take calls. Each environment has its own, so one computer
 * dropping or coming back leaves the requests of the others alone.
 */
function EnvironmentBrowserHost({
  environmentId,
  machineLocal,
  clientHosts,
}: ConnectedEnvironment) {
  // Connected is not yet callable: a saved computer reads as connected from
  // the moment its socket opens, before its connection is registered.
  const callable = useEnvironmentApiAvailable(environmentId);
  useEffect(() => {
    // Read again rather than trusted from the render: the connection can go in
    // between, and the change that took it brings this effect round again.
    if (!callable || readEnvironmentApi(environmentId) === undefined) return;
    const connection = connectEnvironmentBrowserHost({
      environmentId,
      machineLocal,
      clientHosts,
      resolveTarget: resolveThreadBrowserTarget,
      prepare: prepareThreadBrowser,
      onReconnect: () => {
        const shown = useBrowserLiveStore.getState().shownThreadKey;
        const live =
          shown === null ? undefined : useBrowserLiveStore.getState().liveByThreadKey[shown];
        if (live !== undefined && live.threadRef.environmentId === environmentId) {
          claimThreadBrowser(live.threadRef);
        }
      },
      onRelease: (threadRef) => {
        // Another client has this thread's browser now. Pages on screen here
        // stay: the user is looking at them, and opening the thread here
        // claims it back.
        if (useBrowserLiveStore.getState().shownThreadKey !== scopedThreadKey(threadRef)) {
          closeThreadBrowser(threadRef);
        }
      },
      shownThread: {
        current: () => {
          const shown = useBrowserLiveStore.getState().shownThreadKey;
          const live =
            shown === null ? undefined : useBrowserLiveStore.getState().liveByThreadKey[shown];
          return live !== undefined && live.threadRef.environmentId === environmentId
            ? (live.threadRef.threadId as ThreadId)
            : null;
        },
        subscribe: (listener) => useBrowserLiveStore.subscribe(listener),
      },
    });
    hostByEnvironment.set(environmentId, { hostId: connection.hostId, clientHosts });
    // A thread already on screen in this environment was opened here.
    const shown = useBrowserLiveStore.getState().shownThreadKey;
    const live = shown === null ? undefined : useBrowserLiveStore.getState().liveByThreadKey[shown];
    if (live !== undefined && live.threadRef.environmentId === environmentId) {
      claimThreadBrowser(live.threadRef);
    }
    return () => {
      if (hostByEnvironment.get(environmentId)?.hostId === connection.hostId) {
        hostByEnvironment.delete(environmentId);
      }
      connection.disconnect();
    };
  }, [callable, clientHosts, environmentId, machineLocal]);
  return null;
}

/** One browser connection per connected environment, kept for as long as it is connected. */
export function EnvironmentBrowserHosts() {
  return useConnectedEnvironments().map((environment) => (
    <EnvironmentBrowserHost key={environment.environmentId} {...environment} />
  ));
}

/** Every attached page, with the thread it belongs to. */
function attachedPages(): ReadonlyArray<{
  threadRef: ScopedThreadRef;
  live: LiveThreadBrowserRecord;
  tabId: string;
  webContentsId: number;
}> {
  return Object.values(useBrowserLiveStore.getState().liveByThreadKey).flatMap((live) =>
    attachedThreadGuests(live.threadRef).map((guest) => ({
      threadRef: live.threadRef,
      live,
      ...guest,
    })),
  );
}

/**
 * Holds every page to the sites its project allows, and turns what pages do
 * on their own into the questions and signals the panel shows.
 */
export function useBrowserPageWatchers(): void {
  const approvedDomains = useSettings((settings) => settings.agentBrowserApprovedDomains);
  const defaultPolicy = useSettings((settings) => settings.agentBrowserSitePolicy);
  const projectPolicies = useSettings((settings) => settings.agentBrowserProjectSitePolicy);

  // Pushed on every attachment and every change rather than read from settings
  // in the main process: only this side knows which project a page belongs to,
  // and a page whose policy has not arrived is private-network-only until it does.
  useEffect(() => {
    const pushPolicies = () => {
      for (const page of attachedPages()) {
        const projectId = page.live.projectId;
        pushNavigationPolicy(
          page.webContentsId,
          resolveBrowserSiteAccess({
            defaultPolicy,
            projectPolicy: projectPolicies[projectId],
            approvedHosts: approvedDomains[projectId] ?? [],
          }),
        );
      }
    };
    pushPolicies();
    return subscribePreviewWebviews(pushPolicies);
  }, [approvedDomains, defaultPolicy, projectPolicies]);

  // A page that tried to take itself somewhere unapproved. The main process
  // refused it and says so here, because the block is silent on the page: a
  // link that does nothing reads as a broken site, not a question waiting.
  useEffect(() => {
    const subscribe = window.desktopBridge?.onPreviewNavigationBlocked;
    if (subscribe === undefined) return;
    return subscribe((blocked) => {
      const page = attachedPages().find((entry) => entry.webContentsId === blocked.webContentsId);
      if (page === undefined) return;
      const panel = useBrowserPanelStore.getState();
      panel.enqueueBrowserApproval(page.threadRef, {
        id: nextBrowserApprovalId(),
        // Nothing waits on a page's navigation: allowing it loads it again.
        waiting: false,
        host: blocked.host,
        url: blocked.url,
        source: "page",
        fromHost: blocked.fromHost ?? null,
        tabId: page.tabId,
      });
      if (!selectThreadBrowserState(panel.browserStateByThreadKey, page.threadRef).open) {
        // A question nobody can see is a stall, not a prompt.
        panel.setBrowserOpen(page.threadRef, true);
      }
    });
  }, []);

  useEffect(() => {
    const subscribe = window.desktopBridge?.onPreviewUserControl;
    if (subscribe === undefined) return;
    return subscribe((control) => {
      const page = attachedPages().find((entry) => entry.webContentsId === control.webContentsId);
      if (page !== undefined) {
        useBrowserPanelStore.getState().markBrowserUserControlled(page.threadRef);
      }
    });
  }, []);
}

/**
 * Closes the running browser of a thread that is gone: deleted, archived, or a
 * draft that was discarded. Judged only once an environment's threads have
 * arrived, and only when its thread list (or the drafts) actually changes --
 * not on every store update, which streams with every token.
 */
export function usePruneGoneThreadBrowsers(): void {
  useEffect(() => {
    let lastShells = new Map<string, unknown>();
    let lastDrafts: unknown = null;
    const prune = (force: boolean) => {
      const live = useBrowserLiveStore.getState();
      const browsers = Object.entries(live.liveByThreadKey);
      if (browsers.length === 0) return;
      const app = useStore.getState();
      const draftsByKey = useComposerDraftStore.getState().draftThreadsByThreadKey;
      const shells = new Map<string, unknown>();
      for (const [, browser] of browsers) {
        const environment = app.environmentStateById[browser.threadRef.environmentId];
        shells.set(browser.threadRef.environmentId, environment?.threadShellById);
      }
      const changed =
        force ||
        draftsByKey !== lastDrafts ||
        [...shells].some(([environmentId, map]) => lastShells.get(environmentId) !== map);
      lastShells = shells;
      lastDrafts = draftsByKey;
      if (!changed) return;
      const draftKeys = new Set(
        Object.values(draftsByKey).map((draft) =>
          scopedThreadKey(scopeThreadRef(draft.environmentId, draft.threadId)),
        ),
      );
      for (const [key, browser] of browsers) {
        if (live.shownThreadKey === key) continue;
        const environment = app.environmentStateById[browser.threadRef.environmentId];
        if (environment === undefined || !environment.bootstrapComplete) continue;
        const shell = environment.threadShellById[browser.threadRef.threadId];
        const gone = shell === undefined ? !draftKeys.has(key) : shell.archivedAt !== null;
        if (gone) closeThreadBrowser(browser.threadRef);
      }
    };
    prune(true);
    const unsubscribeApp = useStore.subscribe(() => prune(false));
    const unsubscribeDrafts = useComposerDraftStore.subscribe(() => prune(false));
    const unsubscribeLive = useBrowserLiveStore.subscribe((state, previous) => {
      if (state.liveByThreadKey !== previous.liveByThreadKey) prune(true);
    });
    return () => {
      unsubscribeApp();
      unsubscribeDrafts();
      unsubscribeLive();
    };
  }, []);
}

/** Steps idle background pages down, on a slow timer that only works when there are any. */
function useBrowserLifecycleLoop(): void {
  useEffect(() => {
    let running = false;
    const timer = window.setInterval(() => {
      if (running || !hasBackgroundPages()) return;
      running = true;
      void runBrowserLifecycleCheck().finally(() => {
        running = false;
      });
    }, LIFECYCLE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);
}

export function BrowserHostLayer() {
  const navigate = useNavigate();
  useBrowserPageWatchers();
  useBrowserLifecycleLoop();
  usePruneGoneThreadBrowsers();
  // Pages pull focus out of whatever the user is typing in whenever agent input
  // lands in one; the guard notices and hands the focus back.
  useEffect(() => installBrowserFocusGuard(), []);
  useEffect(() => {
    setBrowserThreadOpener((threadRef) => {
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
    });
    return () => setBrowserThreadOpener(null);
  }, [navigate]);

  const live = useBrowserLiveStore((store) => store.liveByThreadKey);
  return (
    <>
      <EnvironmentBrowserHosts />
      {createPortal(
        <div data-testid="browser-host-layer">
          {Object.entries(live).map(([key, browser]) => (
            <LiveThreadBrowserView key={`${key}:${browser.projectId}`} browser={browser} />
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** One thread's pages, drawn over its panel when it is on screen and kept out of sight when not. */
export function LiveThreadBrowserView({ browser }: { browser: LiveThreadBrowserRecord }) {
  const { threadRef, projectId } = browser;
  const threadKey = scopedThreadKey(threadRef);
  const browserState = useBrowserPanelStore((store) =>
    selectThreadBrowserState(store.browserStateByThreadKey, threadRef),
  );
  const shown = useBrowserLiveStore((store) => store.shownThreadKey === threadKey);
  const slotSize = useBrowserLiveStore((store) => store.slotSize);
  const pageStates = useBrowserLiveStore((store) =>
    selectThreadPageStates(store.pageStateByThreadKey, threadRef),
  );
  const setOverlayElement = useBrowserLiveStore((store) => store.setOverlayElement);
  const setTabViewport = useBrowserPanelStore((store) => store.setTabViewport);
  const appearance = useBrowserPanelStore((store) => store.appearance);
  const agentState = useBrowserPanelStore((store) =>
    selectThreadAgentState(store.agentStateByThreadKey, threadRef),
  );
  const setAgentPoint = useBrowserPanelStore((store) => store.setAgentPoint);
  const { resolvedTheme } = useTheme();
  const colorScheme = appearance === "system" ? resolvedTheme : appearance;
  const profile = useBrowserProfilePartition(threadRef.environmentId, projectId);

  const activeTab = selectActiveTab(browserState);
  const activeTabId = activeTab?.id ?? "";
  const visibleTabId = shown ? activeTabId : null;

  // A page on screen is awake and in memory; one leaving the screen starts
  // its idle clock.
  const previousVisible = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousVisible.current;
    if (previous !== null && previous !== visibleTabId) notePageHidden(threadRef, previous);
    if (visibleTabId !== null && visibleTabId !== "") notePageShown(threadRef, visibleTabId);
    previousVisible.current = visibleTabId;
  }, [threadRef, visibleTabId]);

  // The agent's mark is in page coordinates, so it stops meaning anything the
  // moment the page under it changes. It fades rather than blinking out:
  // clicking a link is the most common way to navigate, and cutting the mark on
  // the click leaves the one action you most want confirmed with no trace.
  const agentPoint = agentState.point as AgentPointerPosition | null;
  const agentPointRef = useRef(agentPoint);
  agentPointRef.current = agentPoint;
  const [agentPointRetiring, setAgentPointRetiring] = useState(false);
  const activeUrl = activeTab?.url ?? null;
  useEffect(() => {
    if (agentPointRef.current === null) return;
    setAgentPointRetiring(true);
    const timer = window.setTimeout(() => {
      setAgentPoint(threadRef, null);
      setAgentPointRetiring(false);
    }, POINTER_RETIRE_MS);
    return () => window.clearTimeout(timer);
  }, [activeUrl, setAgentPoint, threadRef]);

  if (profile.status !== "ready") {
    return null;
  }

  const hiddenSize = slotSize ?? DEFAULT_HIDDEN_PAGE_SIZE;
  const containerStyle: CSSProperties = shown
    ? {
        position: "fixed",
        positionAnchor: BROWSER_SLOT_ANCHOR,
        top: "anchor(top)",
        left: "anchor(left)",
        width: "anchor-size(width)",
        height: "anchor-size(height)",
        zIndex: 40,
      }
    : {
        // Underneath the app and invisible besides: nothing here is meant to
        // be seen, only kept running at the size it would have on screen.
        position: "fixed",
        top: 0,
        left: 0,
        width: `${hiddenSize.width}px`,
        height: `${hiddenSize.height}px`,
        zIndex: -1,
        pointerEvents: "none",
      };

  return (
    <div style={containerStyle} data-testid={`browser-live-${threadKey}`}>
      {browserState.tabs.map((tab) => {
        const page = pageStates[tab.id] ?? { drawn: false, evicted: false };
        if (page.evicted && tab.id !== visibleTabId) return null;
        const mode: PreviewFrameMode =
          tab.id === visibleTabId ? "visible" : page.drawn ? "drawn" : "hidden";
        return (
          <PreviewTabFrame
            key={`${profile.partition}:${tab.id}`}
            tab={tab}
            threadRef={threadRef}
            partition={profile.partition}
            isActive={tab.id === activeTabId}
            mode={mode}
            viewport={tab.viewport}
            zoomFactor={tab.zoomFactor}
            colorScheme={colorScheme}
            onResize={
              mode === "visible" ? (next) => setTabViewport(threadRef, tab.id, next) : undefined
            }
            agentPoint={tab.id === agentState.tabId ? agentPoint : null}
            agentPointRetiring={agentPointRetiring}
          />
        );
      })}
      {shown ? (
        // Where the panel draws over the page (the find bar, the new-tab
        // list): inside this layer, since anything in the panel itself would
        // be underneath it.
        <div ref={setOverlayElement} className="pointer-events-none absolute inset-0" />
      ) : null}
    </div>
  );
}
