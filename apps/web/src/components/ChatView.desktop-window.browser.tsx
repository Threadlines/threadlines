import { MessageId } from "@threadlines/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";
// Types `cdp()` as Playwright's session.
import type {} from "vite-plus/test/browser-playwright";

import {
  createSnapshotForTargetUser,
  DEFAULT_VIEWPORT,
  mountChatView,
  registerChatViewSuiteHooks,
  waitForElement,
} from "./ChatView.browser-harness";

// The desktop app: `isElectron` is read when modules load, so this whole file
// runs as the app's own window would (the other ChatView suites are a browser).
vi.mock("../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../env")>()),
  isElectron: true,
}));

vi.mock("../lib/gitStatusState", () => ({
  // Read synchronously by the draft seeder to skip a checkout already known
  // to be missing; these suites never exercise a deleted checkout.
  getGitStatusSnapshot: () => ({ data: null, error: null, cause: null, isPending: false }),
  GIT_STATUS_STALE_MESSAGE: "Source control status isn't updating.",
  useGitStatus: () => ({ data: null, error: null, cause: null, isPending: false }),
  useGitStatuses: () => new Map(),
  rebuildGitStatusSubscription: () => undefined,
  refreshGitStatus: () => Promise.resolve(null),
  refreshLocalGitStatus: () => Promise.resolve(null),
  resetGitStatusStateForTests: () => undefined,
}));

describe("ChatView (full app): the desktop app's window", () => {
  registerChatViewSuiteHooks();

  it("keeps the desktop layout in a window narrower than a phone's breakpoint", async () => {
    const root = document.documentElement;
    // What main.tsx sets in the desktop app, and the Windows window controls'
    // reserve that env(titlebar-area-*) reports.
    root.classList.add("electron", "wco");
    root.style.setProperty("--workspace-controls-right", "150px");
    const mounted = await mountChatView({
      // The window's minimum width (MIN_MAIN_WINDOW_WIDTH in DesktopWindow.ts).
      viewport: { ...DEFAULT_VIEWPORT, name: "desktop-minimum", width: 480 },
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-desktop-minimum" as MessageId,
        targetText: "desktop minimum",
      }),
    });

    try {
      // The title row and the rail stay; the page keeps its rounded corner.
      const titleRow = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="app-titlebar"]'),
        "The desktop app should keep its title row at its minimum width.",
      );
      expect(document.querySelector('[data-slot="navigation-rail"]')).not.toBeNull();
      const panel = document.querySelector<HTMLElement>('[data-testid="app-panel"]')!;
      const shape = document.querySelector<HTMLElement>('[data-slot="app-panel-shape"]')!;
      expect(getComputedStyle(shape).borderTopLeftRadius).not.toBe("0px");
      const corner = document.querySelector<HTMLElement>('[data-slot="app-panel-corner"]')!;
      expect(getComputedStyle(corner).display).not.toBe("none");

      // The list floats over the page, closed, instead of sitting beside it.
      const list = panel.querySelector<HTMLElement>(':scope > [data-slot="sidebar"]')!;
      await vi.waitFor(() => {
        expect(list.hasAttribute("data-overlay")).toBe(true);
        expect(list.dataset.state).toBe("collapsed");
      });

      // The thread's header has a row of its own, title included, and nothing
      // in the title row reaches the window controls.
      await vi.waitFor(() => {
        const ownRow = document.querySelector<HTMLElement>('header[data-find-region="chat"]');
        expect(ownRow?.querySelector("h2")?.textContent).toBe("Browser test thread");
        expect(ownRow!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          titleRow.getBoundingClientRect().bottom,
        );
      });
      const controlsStart = window.innerWidth - 150;
      for (const control of titleRow.querySelectorAll("button, a")) {
        if (control.getBoundingClientRect().width === 0) continue;
        expect(control.getBoundingClientRect().right).toBeLessThanOrEqual(controlsStart);
      }

      // Wide again: the header goes back up, and the list beside the page.
      await mounted.setViewport({ ...DEFAULT_VIEWPORT, name: "desktop-wide", width: 1200 });
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-testid="titlebar-slot"] [data-active-thread-title]'),
        ).not.toBeNull();
        expect(list.hasAttribute("data-overlay")).toBe(false);
        expect(list.dataset.state).toBe("expanded");
      });
    } finally {
      await mounted.cleanup();
      root.style.removeProperty("--workspace-controls-right");
      root.classList.remove("electron", "wco");
    }
  });

  it("rounds the panel's corner without a mask layer the size of the panel", async () => {
    // A rounded clip around the panel's pages gives every separately drawn
    // part inside it (the chat's scroller, the list's) a mask as big as the
    // panel: a drawn layer that belongs to no element (index.css, "The work
    // panel's rounded corner").
    document.documentElement.classList.add("electron");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-desktop-corner" as MessageId,
        targetText: "desktop corner",
      }),
    });
    const session = cdp();
    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="sidebar-inner"]'),
        "The thread list should show beside the thread.",
      );
      const panel = document.querySelector<HTMLElement>('[data-testid="app-panel"]')!;
      const panelArea = panel.clientWidth * panel.clientHeight * devicePixelRatio ** 2;
      let layers: ReadonlyArray<{
        readonly drawsContent: boolean;
        readonly backendNodeId?: number;
        readonly width: number;
        readonly height: number;
      }> | null = null;
      session.on("LayerTree.layerTreeDidChange", (event) => {
        if (event.layers) layers = event.layers;
      });
      await session.send("LayerTree.enable");
      // The tree is reported on the next frame the page draws, and again as
      // it changes: wait for one where the chat's scroller is drawn on its
      // own, so there is something to mask (an early frame can come before
      // it is). A busy runner can take seconds to composite the chat.
      const awaitScrollerLayer = () =>
        vi.waitFor(
          () => {
            document.body.style.outline = document.body.style.outline ? "" : "0 solid transparent";
            expect(layers?.some((layer) => layer.drawsContent && layer.backendNodeId)).toBe(true);
          },
          { timeout: 5_000 },
        );
      await awaitScrollerLayer();
      // While something fades (a pill or button appearing in the chat), the
      // browser lifts what it overlaps onto layers of their own until the
      // fade ends. The rounded clip's masks stay for good: read the tree
      // once the fades that end have ended (a spinner never does).
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
          .map((animation) => animation.finished.catch(() => undefined)),
      );
      layers = null;
      await awaitScrollerLayer();
      const masks = layers!.filter(
        (layer) =>
          layer.drawsContent &&
          layer.backendNodeId === undefined &&
          layer.width * layer.height >= panelArea * 0.5,
      );
      expect(masks).toEqual([]);
    } finally {
      await session.send("LayerTree.disable");
      document.body.style.outline = "";
      await mounted.cleanup();
      document.documentElement.classList.remove("electron");
    }
  });

  it("mounts the layer that holds every thread's browser pages", async () => {
    // Its code is a chunk only the desktop app fetches (routes/__root.tsx), so
    // the window has to load it and mount it by itself, with no panel open.
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-desktop-browser-host" as MessageId,
        targetText: "desktop browser host",
      }),
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="browser-host-layer"]'),
        "The desktop app should mount the browser host layer at its root.",
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
