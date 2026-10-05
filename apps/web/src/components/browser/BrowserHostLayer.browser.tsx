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

import { makeBrowserTab, useBrowserPanelStore } from "../../browserPanelStore";
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

// The runtime keeps its own behaviour; spying is how the test reaches the
// listeners its connection registry was given.
vi.mock("../../environments/runtime", { spy: true });

const ENVIRONMENT = EnvironmentId.make("env-layer");
const SHOWN = scopeThreadRef(ENVIRONMENT, ThreadId.make("thread-shown"));
const AWAY = scopeThreadRef(ENVIRONMENT, ThreadId.make("thread-away"));
const PROJECT = "project-layer" as ProjectId;

/**
 * The layer draws one thread's pages over its panel and keeps every other
 * thread's running out of sight. A real document, so CSS anchor positioning
 * and computed styles are the browser's own; a stand-in slot plays the panel.
 */
describe("LiveThreadBrowserView", () => {
  afterEach(() => {
    resetBrowserLiveStoreForTests();
    useBrowserPanelStore.setState({ browserStateByThreadKey: {} });
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
      expect(frame(working.id).dataset.frameMode).toBe("drawn");
      expect(getComputedStyle(frame(working.id)).visibility).toBe("visible");
      expect(getComputedStyle(frame(working.id)).opacity).toBe("0");
      // Another thread's page: not painted, and under the app.
      expect(frame(away.id).dataset.frameMode).toBe("hidden");
      expect(getComputedStyle(frame(away.id)).visibility).toBe("hidden");
      const awayContainer = document.querySelector<HTMLElement>(
        `[data-testid="browser-live-${scopedThreadKey(AWAY)}"]`,
      )!;
      expect(getComputedStyle(awayContainer).zIndex).toBe("-1");
      expect(awayContainer.getBoundingClientRect().width).toBe(500);
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
