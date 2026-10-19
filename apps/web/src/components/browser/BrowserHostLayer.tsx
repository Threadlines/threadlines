import { scopeThreadRef, scopedThreadKey } from "@threadlines/client-runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@threadlines/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import {
  selectActiveTab,
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
import { resolveBrowserSiteAccess } from "@threadlines/shared/preview";
import {
  approveBrowserHostForProject,
  pushNavigationPolicy,
  setBrowserSitePolicyForProject,
} from "./browserApprovals";
import { nextBrowserApprovalId } from "./browserApprovalRequests";
import { installBrowserFocusGuard } from "./browserFocusGuard";
import { openTabForPage } from "./openInBrowserPanel";
import { noteSignInPopup } from "./signInPopups";
import {
  forgetThreadPages,
  hasBackgroundPages,
  notePageHidden,
  notePageShown,
  runBrowserLifecycleCheck,
} from "./browserLifecycle";
import { serveLoopbackTunnels } from "./loopbackTunnels";
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
 * out of sight, in a layer above the app that shows nothing and takes no
 * clicks: painted invisibly while an agent is using it, hidden once idle,
 * frozen later, closed when memory runs short (see `browserLifecyclePlan.ts`).
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

/** How often this computer's use is reported while it is connected. */
const PRESENCE_REPORT_INTERVAL_MS = 30_000;

/**
 * This client's host id per environment, for claiming a thread's browser;
 * `presence` when the environment is told how recently this computer was used.
 */
const hostByEnvironment = new Map<
  string,
  { hostId: string; clientHosts: boolean; presence: boolean }
>();

/**
 * This window's name to each environment, for as long as the page lives. A
 * connection that drops and comes back is the same browser with the same
 * pages, and must not read as the browser having moved to another computer.
 */
const stableHostIds = new Map<string, string>();
function stableHostIdFor(environmentId: string): string {
  let hostId = stableHostIds.get(environmentId);
  if (hostId === undefined) {
    hostId = `client:${Math.random().toString(36).slice(2)}`;
    stableHostIds.set(environmentId, hostId);
  }
  return hostId;
}

/** Milliseconds since anyone touched this computer, or null outside the desktop. */
async function readSystemIdleMs(): Promise<number | null> {
  const read = window.desktopBridge?.getSystemIdleMs;
  if (read === undefined) return null;
  try {
    return await read();
  } catch {
    return null;
  }
}

/**
 * Tells environments how recently this computer was used, so a thread's
 * browser opens, and moves, to the computer the user is at. One environment,
 * or every one this client hosts a browser for.
 */
async function reportPresence(environmentId?: string): Promise<void> {
  const idleMs = await readSystemIdleMs();
  if (idleMs === null) return;
  for (const [id, host] of hostByEnvironment) {
    if (!host.presence || (environmentId !== undefined && id !== environmentId)) continue;
    void readEnvironmentApi(id as EnvironmentId)
      ?.previewAutomation.active({ hostId: host.hostId, idleMs })
      .catch(() => undefined);
  }
}

/**
 * Tells the environment the user opened this thread's browser here, so its
 * agent requests come to this client (and its pages) from now on.
 *
 * Also how a panel back on screen after a launch or a reconnect says so. With
 * how recently this computer was used, the environment can tell the two
 * apart: one put back on a computer nobody is at does not take the browser
 * from one somebody is.
 */
export function claimThreadBrowser(threadRef: ScopedThreadRef): void {
  const host = hostByEnvironment.get(threadRef.environmentId);
  if (host === undefined || !host.clientHosts) return;
  void (async () => {
    const idleMs = host.presence ? await readSystemIdleMs() : null;
    // A connection being rebuilt is gone a moment before its host entry is.
    // Skipping loses nothing: the host that replaces this one claims the
    // thread on screen as it connects.
    await readEnvironmentApi(threadRef.environmentId)?.previewAutomation.claim({
      hostId: host.hostId,
      threadId: threadRef.threadId,
      ...(idleMs === null ? {} : { idleMs }),
    });
  })().catch(() => undefined);
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
  /** The server is told how recently this computer was used, and carries loopback tunnels. */
  readonly presence: boolean;
  /**
   * This client's pages reach the environment's `localhost` through the
   * loopback tunnel: another computer, connected directly rather than through
   * the relay, whose server carries tunnels.
   */
  readonly loopbackTunnel: boolean;
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
        presence: primary.capabilities.browserLoopbackTunnel === true,
        loopbackTunnel: false,
      });
    }
    for (const [environmentId, runtime] of Object.entries(saved)) {
      if (environmentId === primary?.environmentId) continue;
      if (runtime.connectionState !== "connected" || runtime.descriptor === null) continue;
      const tunnels = runtime.descriptor.capabilities.browserLoopbackTunnel === true;
      environments.push({
        environmentId: environmentId as EnvironmentId,
        machineLocal: false,
        clientHosts: runtime.descriptor.capabilities.browserClientHosts === true,
        presence: tunnels,
        loopbackTunnel: tunnels && runtime.route !== "relay",
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
  presence,
  loopbackTunnel,
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
      hostId: stableHostIdFor(environmentId),
      machineLocal,
      clientHosts,
      loopbackTunnel,
      resolveTarget: resolveThreadBrowserTarget,
      prepare: prepareThreadBrowser,
      onReconnect: () => {
        void reportPresence(environmentId);
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
    hostByEnvironment.set(environmentId, { hostId: connection.hostId, clientHosts, presence });
    void reportPresence(environmentId);
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
  }, [callable, clientHosts, environmentId, loopbackTunnel, machineLocal, presence]);
  return null;
}

/**
 * One browser connection per connected environment, kept for as long as it is
 * connected, and this window's way to their `localhost`.
 */
export function EnvironmentBrowserHosts() {
  useEffect(() => serveLoopbackTunnels(), []);
  // How recently this computer was used, now and then and whenever the
  // window comes forward: the agent's browser goes where the user is.
  useEffect(() => {
    const report = () => void reportPresence();
    const timer = window.setInterval(report, PRESENCE_REPORT_INTERVAL_MS);
    window.addEventListener("focus", report);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", report);
    };
  }, []);
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
  const trustedCertificates = useSettings((settings) => settings.agentBrowserTrustedCertificates);

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
            trustedCertificates: trustedCertificates[projectId] ?? [],
          }),
        );
      }
    };
    pushPolicies();
    return subscribePreviewWebviews(pushPolicies);
  }, [approvedDomains, defaultPolicy, projectPolicies, trustedCertificates]);

  // A page on the user's own machine or network was refused for a certificate
  // the system does not trust, which a dev server's self-made one is. Asked in
  // the approval line, where allowing trusts that one certificate for the
  // project and loads the page again.
  useEffect(() => {
    const subscribe = window.desktopBridge?.onPreviewCertificateUntrusted;
    if (subscribe === undefined) return;
    return subscribe((untrusted) => {
      const page = attachedPages().find((entry) => entry.webContentsId === untrusted.webContentsId);
      if (page === undefined) return;
      const panel = useBrowserPanelStore.getState();
      panel.enqueueBrowserApproval(page.threadRef, {
        id: nextBrowserApprovalId(),
        waiting: false,
        host: untrusted.host,
        url: untrusted.url,
        source: "page",
        fromHost: null,
        tabId: page.tabId,
        certificate: { fingerprint: untrusted.fingerprint },
      });
      if (!selectThreadBrowserState(panel.browserStateByThreadKey, page.threadRef).open) {
        panel.setBrowserOpen(page.threadRef, true);
      }
    });
  }, []);

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

  // A page asked for a new tab or window. The desktop opened nothing; the tab
  // opens here, in the page's own thread, beside the page.
  useEffect(() => {
    const subscribe = window.desktopBridge?.onPreviewOpenTab;
    if (subscribe === undefined) return;
    return subscribe((request) => {
      const page = attachedPages().find((entry) => entry.webContentsId === request.webContentsId);
      if (page === undefined) return;
      openTabForPage({
        threadRef: page.threadRef,
        projectId: page.live.projectId,
        openerTabId: page.tabId,
        url: request.url,
        background: request.background,
      });
    });
  }, []);

  useEffect(() => window.desktopBridge?.onPreviewPopup?.(noteSignInPopup), []);

  // A site the user allowed from a sign-in pop-up's own question. The pop-up
  // has gone there already; the answer is the project's, as if given in the
  // approval line, and recording it pushes the policy to every page.
  useEffect(() => {
    const subscribe = window.desktopBridge?.onPreviewSiteAllowed;
    if (subscribe === undefined) return;
    return subscribe((allowed) => {
      const page = attachedPages().find((entry) => entry.webContentsId === allowed.webContentsId);
      if (page === undefined) return;
      if (allowed.allowAll) {
        setBrowserSitePolicyForProject(page.live.projectId, "any");
      } else {
        approveBrowserHostForProject(page.live.projectId, allowed.host);
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
        // Nothing here is meant to be seen, only kept running at the size it
        // would have on screen: its pages are hidden, or drawn invisibly for
        // an agent. Above everything rather than under the app, because
        // Chromium skips drawing what the app's opaque background covers, and
        // a page that is not drawn produces no frames, so a screenshot of it
        // waits forever. Clicks pass through it to the app.
        position: "fixed",
        top: 0,
        left: 0,
        width: `${hiddenSize.width}px`,
        height: `${hiddenSize.height}px`,
        zIndex: 2147483647,
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
