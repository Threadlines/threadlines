import { scopeThreadRef, scopedThreadKey } from "@threadlines/client-runtime";
import {
  type EnvironmentApi,
  EnvironmentId,
  type ProjectId,
  ThreadId,
} from "@threadlines/contracts";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  makeBrowserTab,
  selectThreadAgentState,
  useBrowserPanelStore,
  type BrowserTab,
} from "../../browserPanelStore";
import { resetBrowserLiveStoreForTests, useBrowserLiveStore } from "../../browserLiveStore";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { subscribeEnvironmentConnections } from "../../environments/runtime";
import {
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime/catalog";
import { useStore } from "../../store";
import {
  BROWSER_SLOT_ANCHOR,
  EnvironmentBrowserHosts,
  LiveThreadBrowserView,
  usePruneGoneThreadBrowsers,
} from "./BrowserHostLayer";
import {
  resetThreadBrowserAutomationForTests,
  resolveThreadBrowserTarget,
} from "./threadBrowserAutomation";

// The runtime keeps its own behaviour; spying is how the test reaches the
// listeners its connection registry was given.
vi.mock("../../environments/runtime", { spy: true });

const ENVIRONMENT = EnvironmentId.make("env-layer");
const SHOWN = scopeThreadRef(ENVIRONMENT, ThreadId.make("thread-shown"));
const AWAY = scopeThreadRef(ENVIRONMENT, ThreadId.make("thread-away"));
const PROJECT = "project-layer" as ProjectId;

/** The thread on screen with these tabs open, the first one in front. */
async function renderThreadOnScreen(tabs: readonly [BrowserTab, ...BrowserTab[]]) {
  window.desktopBridge = {
    setTheme: () => Promise.resolve(),
    previewProfilePartition: () =>
      Promise.resolve({ partition: `persist:threadlines-preview-${"a".repeat(32)}` }),
  } as unknown as NonNullable<typeof window.desktopBridge>;
  useBrowserPanelStore.setState({
    browserStateByThreadKey: {
      [scopedThreadKey(SHOWN)]: { open: true, tabs: [...tabs], activeTabId: tabs[0].id },
    },
  });
  const live = useBrowserLiveStore.getState();
  live.ensureLive(SHOWN, PROJECT);
  live.setShown(SHOWN);
  const screen = await render(
    <LiveThreadBrowserView browser={{ threadRef: SHOWN, projectId: PROJECT }} />,
  );
  await vi.waitFor(
    () =>
      expect(document.querySelector(`[data-testid="browser-frame-${tabs[0].id}"]`)).not.toBeNull(),
    { timeout: 4_000 },
  );
  return screen;
}

/**
 * The agent's pointer on the page in front, read in the same task as the
 * change that caused it, so none of its own timers can have run in between.
 */
function agentPointerAfter(change: () => void) {
  flushSync(change);
  const mark = document.querySelector<HTMLElement>('[data-testid="agent-pointer"]');
  return mark === null
    ? null
    : {
        settled: mark.dataset.settled,
        clicking: mark.querySelector('[data-testid="agent-pointer-click"]') !== null,
        at: mark.style.transform,
      };
}

/** An agent's request to act on a tab, as the browser host resolves one. */
function agentRequestOn(tabId: string) {
  return resolveThreadBrowserTarget(SHOWN, {
    requestId: "request",
    agentId: "agent",
    operation: "click",
    input: { tabId },
  });
}
const acting = (at: string) => ({ settled: "false", clicking: true, at });
const resting = (at: string) => ({ settled: "true", clicking: false, at });

/**
 * The layer draws one thread's pages over its panel and keeps every other
 * thread's running out of sight. A real document, so CSS anchor positioning
 * and computed styles are the browser's own; a stand-in slot plays the panel.
 */
describe("LiveThreadBrowserView", () => {
  afterEach(() => {
    resetBrowserLiveStoreForTests();
    resetThreadBrowserAutomationForTests();
    useBrowserPanelStore.setState({ browserStateByThreadKey: {}, agentStateByThreadKey: {} });
    Reflect.deleteProperty(window, "desktopBridge");
  });

  it("puts the thread on screen exactly over its panel, and the rest out of sight", async () => {
    window.desktopBridge = {
      setTheme: () => Promise.resolve(),
      previewProfilePartition: () =>
        Promise.resolve({ partition: `persist:threadlines-preview-${"a".repeat(32)}` }),
    } as unknown as NonNullable<typeof window.desktopBridge>;
    const current = { ...makeBrowserTab(), url: "http://localhost:5173/" };
    const working = { ...makeBrowserTab(), url: "http://localhost:5173/settings" };
    const away = { ...makeBrowserTab(), url: "http://localhost:3000/" };
    useBrowserPanelStore.setState({
      browserStateByThreadKey: {
        [scopedThreadKey(SHOWN)]: { open: true, tabs: [current, working], activeTabId: current.id },
        [scopedThreadKey(AWAY)]: { open: true, tabs: [away], activeTabId: away.id },
      },
    });
    const live = useBrowserLiveStore.getState();
    live.ensureLive(SHOWN, PROJECT);
    live.ensureLive(AWAY, PROJECT);
    live.setShown(SHOWN);
    live.setSlotSize({ width: 500, height: 300 });
    // An agent is using the second tab, so it stays painted though hidden.
    live.setPageState(SHOWN, working.id, { drawn: true });

    const screen = await render(
      <>
        <div
          data-testid="slot"
          style={
            {
              position: "absolute",
              left: "120px",
              top: "60px",
              width: "500px",
              height: "300px",
              anchorName: BROWSER_SLOT_ANCHOR,
            } as React.CSSProperties
          }
        />
        <LiveThreadBrowserView browser={{ threadRef: SHOWN, projectId: PROJECT }} />
        <LiveThreadBrowserView browser={{ threadRef: AWAY, projectId: PROJECT }} />
      </>,
    );

    try {
      const shownContainer = () =>
        document.querySelector<HTMLElement>(
          `[data-testid="browser-live-${scopedThreadKey(SHOWN)}"]`,
        );
      await vi.waitFor(() => expect(shownContainer()).not.toBeNull(), { timeout: 4_000 });
      const slot = document.querySelector<HTMLElement>('[data-testid="slot"]')!;
      const sameBox = () => {
        const page = shownContainer()!.getBoundingClientRect();
        const area = slot.getBoundingClientRect();
        expect(Math.round(page.left)).toBe(Math.round(area.left));
        expect(Math.round(page.top)).toBe(Math.round(area.top));
        expect(Math.round(page.width)).toBe(Math.round(area.width));
        expect(Math.round(page.height)).toBe(Math.round(area.height));
      };
      sameBox();
      // The panel moving without changing size is followed too.
      slot.style.left = "260px";
      await vi.waitFor(sameBox, { timeout: 2_000 });

      const frame = (tabId: string) =>
        document.querySelector<HTMLElement>(`[data-testid="browser-frame-${tabId}"]`)!;
      expect(frame(current.id).dataset.frameMode).toBe("visible");
      // Painted but invisible: a screenshot of a hidden page never returns.
      // Through a filter, since Chromium leaves an element at zero opacity
      // out of the frame, and then the page stops producing frames too.
      expect(frame(working.id).dataset.frameMode).toBe("drawn");
      expect(getComputedStyle(frame(working.id)).visibility).toBe("visible");
      expect(getComputedStyle(frame(working.id)).filter).toBe("opacity(0)");
      expect(getComputedStyle(frame(working.id)).opacity).toBe("1");
      // Another thread's page: not painted, and in a layer that takes no
      // clicks. Above the app, which would otherwise cover it: Chromium does
      // not draw what an opaque layer hides, drawn page or not.
      expect(frame(away.id).dataset.frameMode).toBe("hidden");
      expect(getComputedStyle(frame(away.id)).visibility).toBe("hidden");
      const awayContainer = document.querySelector<HTMLElement>(
        `[data-testid="browser-live-${scopedThreadKey(AWAY)}"]`,
      )!;
      expect(getComputedStyle(awayContainer).pointerEvents).toBe("none");
      expect(Number(getComputedStyle(awayContainer).zIndex)).toBeGreaterThan(
        Number(getComputedStyle(shownContainer()!).zIndex),
      );
      expect(awayContainer.getBoundingClientRect().width).toBe(500);
    } finally {
      screen.unmount();
    }
  });

  it("lets every page ask for new tabs", async () => {
    const tab = { ...makeBrowserTab(), url: "http://localhost:5173/" };
    const screen = await renderThreadOnScreen([tab]);
    try {
      // Without it Chromium refuses every target="_blank" link before the
      // desktop is asked, and the link does nothing. React drops a boolean.
      const page = document.querySelector(`[data-testid="browser-frame-${tab.id}"] webview`);
      expect(page?.hasAttribute("allowpopups")).toBe(true);
    } finally {
      screen.unmount();
    }
  });

  it("shows each thing the agent does once, and its pointer at rest when the thread comes back on screen", async () => {
    const tab = { ...makeBrowserTab(), url: "http://localhost:5173/" };
    const screen = await renderThreadOnScreen([tab]);

    try {
      const live = useBrowserLiveStore.getState();
      const first = "translate3d(40px, 30px, 0px)";

      // The agent clicks while the page is being watched: the click is shown.
      expect(
        agentPointerAfter(() => agentRequestOn(tab.id).onAgentPoint({ x: 40, y: 30 })),
      ).toEqual(acting(first));

      // Another thread and straight back: nothing happened in between, so
      // nothing is acted out again.
      expect(agentPointerAfter(() => live.setShown(AWAY))).toBeNull();
      expect(agentPointerAfter(() => live.setShown(SHOWN))).toEqual(resting(first));

      // The next thing the agent does is shown as usual.
      expect(
        agentPointerAfter(() => agentRequestOn(tab.id).onAgentPoint({ x: 120, y: 80 })),
      ).toEqual(acting("translate3d(120px, 80px, 0px)"));
    } finally {
      screen.unmount();
    }
  });

  it("keeps the agent's pointer with the page it touched", async () => {
    const watched = { ...makeBrowserTab(), url: "http://localhost:5173/" };
    const other = { ...makeBrowserTab(), url: "http://localhost:5173/settings" };
    const screen = await renderThreadOnScreen([watched, other]);

    try {
      const panel = useBrowserPanelStore.getState();
      const gone = () =>
        vi.waitFor(() => expect(agentPointerAfter(() => {})).toBeNull(), { timeout: 2_000 });
      const onWatched = "translate3d(40px, 30px, 0px)";
      const onOther = "translate3d(300px, 200px, 0px)";
      expect(
        agentPointerAfter(() => agentRequestOn(watched.id).onAgentPoint({ x: 40, y: 30 })),
      ).toEqual(acting(onWatched));

      // The agent goes to work in its other tab. The page being watched keeps
      // its mark where it was, and is not given the other page's.
      expect(
        agentPointerAfter(() => agentRequestOn(other.id).onAgentPoint({ x: 300, y: 200 })),
      ).toEqual(acting(onWatched));

      // Each tab shows where the agent was on its own page, whichever the
      // user looks at and however often.
      expect(agentPointerAfter(() => panel.selectTab(SHOWN, other.id))).toEqual(resting(onOther));
      expect(agentPointerAfter(() => panel.selectTab(SHOWN, watched.id))).toEqual(
        resting(onWatched),
      );

      // A page that moves on takes its mark with it, fading rather than
      // blinking out. So does a click made on that page and only reported
      // once it had gone: it is seen, and then it goes.
      const reportedLate = agentRequestOn(watched.id);
      expect(
        agentPointerAfter(() => panel.setTabUrl(SHOWN, watched.id, "http://localhost:5173/next")),
      ).toEqual(resting(onWatched));
      await gone();
      expect(agentPointerAfter(() => reportedLate.onAgentPoint({ x: 10, y: 10 }))).toEqual(
        acting("translate3d(10px, 10px, 0px)"),
      );
      await gone();

      // The other page's mark is its own, and goes when its tab is closed. An
      // answer that arrives after that has no page left to mark.
      const answeredAfterClose = agentRequestOn(other.id);
      expect(agentPointerAfter(() => panel.selectTab(SHOWN, other.id))).toEqual(resting(onOther));
      flushSync(() => panel.closeTab(SHOWN, other.id));
      answeredAfterClose.onAgentPoint({ x: 5, y: 5 });
      expect(
        selectThreadAgentState(useBrowserPanelStore.getState().agentStateByThreadKey, SHOWN)
          .pointByTabId,
      ).toEqual({});
    } finally {
      screen.unmount();
    }
  });

  it("closes the running browser of a thread that no longer exists, unless it is on screen", async () => {
    // The environment's threads have arrived, and neither thread is among them.
    useStore
      .getState()
      .syncServerShellSnapshot(
        { snapshotSequence: 1, projects: [], threads: [], updatedAt: "2026-10-02T00:00:00.000Z" },
        ENVIRONMENT,
      );
    const live = useBrowserLiveStore.getState();
    live.ensureLive(SHOWN, PROJECT);
    live.ensureLive(AWAY, PROJECT);
    live.setShown(SHOWN);

    function Pruner() {
      usePruneGoneThreadBrowsers();
      return null;
    }
    const screen = await render(<Pruner />);
    try {
      await vi.waitFor(() =>
        expect(Object.keys(useBrowserLiveStore.getState().liveByThreadKey)).toEqual([
          scopedThreadKey(SHOWN),
        ]),
      );
    } finally {
      screen.unmount();
      useStore.setState({ environmentStateById: {}, activeEnvironmentId: null });
    }
  });
});

/**
 * A saved computer reads as connected a moment before its connection is
 * registered and can take calls, and again while one is being rebuilt. The
 * registry is the real one; a stand-in connection is put in its place and the
 * registry's own listeners are told, as they are when a real one registers.
 */
describe("EnvironmentBrowserHosts", () => {
  const OTHER = EnvironmentId.make("env-layer-other");
  const registered = new Map<EnvironmentId, EnvironmentApi>();

  const appearConnected = (environmentId: EnvironmentId) =>
    useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
      connectionState: "connected",
      descriptor: {
        environmentId,
        label: "Other computer",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: false, browserClientHosts: true },
      },
    });
  const standInConnection = () => {
    const disconnect = vi.fn();
    const connectClient = vi.fn(() => disconnect);
    const api = { previewAutomation: { connectClient } } as unknown as EnvironmentApi;
    return { api, connectClient, disconnect };
  };
  const announceRegistry = () => {
    __resetEnvironmentApiOverridesForTests();
    for (const [environmentId, api] of registered) {
      __setEnvironmentApiOverrideForTests(environmentId, api);
    }
    flushSync(() => {
      for (const [listener] of vi.mocked(subscribeEnvironmentConnections).mock.calls) listener();
    });
  };

  afterEach(() => {
    registered.clear();
    resetSavedEnvironmentRuntimeStoreForTests();
    __resetEnvironmentApiOverridesForTests();
    vi.mocked(subscribeEnvironmentConnections).mockClear();
    Reflect.deleteProperty(window, "desktopBridge");
  });

  it("holds each computer's connection while it can take calls, apart from the others'", async () => {
    window.desktopBridge = {} as NonNullable<typeof window.desktopBridge>;
    const first = standInConnection();
    const second = standInConnection();

    appearConnected(ENVIRONMENT);
    const screen = await render(<EnvironmentBrowserHosts />);
    try {
      registered.set(ENVIRONMENT, first.api);
      announceRegistry();
      expect(first.connectClient).toHaveBeenCalledOnce();

      flushSync(() => appearConnected(OTHER));
      registered.set(OTHER, second.api);
      announceRegistry();
      expect(second.connectClient).toHaveBeenCalledOnce();
      expect(first.connectClient).toHaveBeenCalledOnce();
      expect(first.disconnect).not.toHaveBeenCalled();

      // The first computer's connection is being rebuilt; it still reads as connected.
      registered.delete(ENVIRONMENT);
      announceRegistry();
      expect(first.disconnect).toHaveBeenCalledOnce();
      expect(second.disconnect).not.toHaveBeenCalled();
    } finally {
      screen.unmount();
    }
  });
});
