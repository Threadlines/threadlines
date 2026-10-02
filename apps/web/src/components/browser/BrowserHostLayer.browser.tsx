import { scopeThreadRef, scopedThreadKey } from "@threadlines/client-runtime";
import { EnvironmentId, type ProjectId, ThreadId } from "@threadlines/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { makeBrowserTab, useBrowserPanelStore } from "../../browserPanelStore";
import { resetBrowserLiveStoreForTests, useBrowserLiveStore } from "../../browserLiveStore";
import { useStore } from "../../store";
import {
  BROWSER_SLOT_ANCHOR,
  LiveThreadBrowserView,
  usePruneGoneThreadBrowsers,
} from "./BrowserHostLayer";

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
