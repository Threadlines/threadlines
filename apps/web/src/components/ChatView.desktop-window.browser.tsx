import { MessageId } from "@threadlines/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

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
      expect(getComputedStyle(panel).borderTopLeftRadius).not.toBe("0px");

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
});
