import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

// The provider reads the active thread from the route so a toast can offer to
// jump to it. This case is about stacking, so it mounts outside a router and
// says there is no route rather than standing one up.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => undefined,
}));

import { ToastProvider, toastManager } from "./toast";

/**
 * Every interactive overlay in this app -- menu, popover, dialog, tooltip,
 * sheet -- sits at `z-50`, and the toast viewport is the only thing that has
 * ever sat above them. That mattered in practice rather than in theory: a
 * toast lands in the top-right corner, which is where the thread panel's tab
 * menu opens into, and at `z-100` the toast took the clicks meant for the menu.
 *
 * This asserts the layer rather than hit-testing it. Fixed positioning inside
 * the test harness resolves against a wider ancestor than the window, so the
 * toast renders past the right edge and `elementFromPoint` cannot reach it --
 * the geometry there says nothing about the real app, while the stacking order
 * is the same code either way.
 */
const APP_OVERLAY_LAYER = 50;

describe("toast layering", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("sits below the layer every menu, popover and dialog is on", async () => {
    const mounted = await render(
      <ToastProvider>
        <div>conversation</div>
      </ToastProvider>,
    );

    try {
      toastManager.add({
        type: "info",
        title: "Update Available: Claude v2.1.228",
        description: "Install the update now or review provider settings.",
        timeout: 0,
      });

      const viewport = await vi.waitFor(() => {
        const found = document.querySelector<HTMLElement>("[data-slot='toast-viewport']");
        expect(found).not.toBeNull();
        // Wait for a toast to actually be in it, so this cannot pass against an
        // empty viewport that was never given the chance to cover anything.
        expect(found!.firstElementChild).not.toBeNull();
        return found!;
      });

      const zIndex = Number.parseInt(getComputedStyle(viewport).zIndex, 10);
      expect(Number.isNaN(zIndex)).toBe(false);
      expect(
        zIndex,
        `the toast viewport is at z-index ${zIndex}; anything at or above ${APP_OVERLAY_LAYER} swallows clicks meant for an open menu`,
      ).toBeLessThan(APP_OVERLAY_LAYER);
      // Still above the page it floats over.
      expect(zIndex).toBeGreaterThan(0);

      // The card inside inherits the viewport's stacking context, so its own
      // very high z-index cannot lift it out past the overlays.
      const card = viewport.firstElementChild as HTMLElement;
      expect(getComputedStyle(card).position).toBe("absolute");
      expect(getComputedStyle(viewport).position).toBe("fixed");
    } finally {
      await mounted.unmount();
    }
  });
});
