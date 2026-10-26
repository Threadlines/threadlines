import "../../index.css";

import type { DesktopBridge } from "@threadlines/contracts";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

// The provider reads the active thread from the route so a toast can offer to
// jump to it. This case is about stacking, so it mounts outside a router and
// says there is no route rather than standing one up.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => undefined,
}));

import { Dialog, DialogPopup, DialogTitle } from "./dialog";
import { ToastProvider, stackedThreadToast, toastManager } from "./toast";

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

/**
 * Says whether this page has focus, for the rest of the spec. Notice clocks run
 * only while the window is in front, and a spec's frame has focus only if an
 * earlier spec happened to move it there, so the clock specs say it outright.
 */
function setPageFocus(focused: boolean) {
  const spy = vi.spyOn(document, "hasFocus").mockReturnValue(focused);
  onTestFinished(() => spy.mockRestore());
}

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

  it("rises above a dialog's dimmed backdrop while the dialog is open", async () => {
    const mounted = await render(
      <ToastProvider>
        <Dialog open>
          <DialogPopup>
            <DialogTitle>Add provider instance</DialogTitle>
          </DialogPopup>
        </Dialog>
      </ToastProvider>,
    );

    try {
      toastManager.add({ type: "error", title: "Could not add provider instance", timeout: 0 });
      const viewport = await vi.waitFor(() => {
        const found = document.querySelector<HTMLElement>("[data-slot='toast-viewport']");
        expect(found?.firstElementChild).toBeTruthy();
        return found!;
      });
      const backdrop = document.querySelector<HTMLElement>("[data-slot='dialog-backdrop']");
      expect(backdrop).not.toBeNull();

      const zIndexOf = (element: HTMLElement) =>
        Number.parseInt(getComputedStyle(element).zIndex, 10);
      expect(zIndexOf(viewport)).toBeGreaterThan(zIndexOf(backdrop!));

      await mounted.rerender(
        <ToastProvider>
          <Dialog open={false}>
            <DialogPopup>
              <DialogTitle>Add provider instance</DialogTitle>
            </DialogPopup>
          </Dialog>
        </ToastProvider>,
      );
      await vi.waitFor(() => expect(zIndexOf(viewport)).toBeLessThan(APP_OVERLAY_LAYER));
    } finally {
      toastManager.close();
      await mounted.unmount();
    }
  });
});

describe("notice reasons and clocks", () => {
  afterEach(() => {
    toastManager.close();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("shows an error's whole reason instead of one cut-off line", async () => {
    const mounted = await render(
      <ToastProvider>
        <div>conversation</div>
      </ToastProvider>,
    );

    try {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Clone failed",
          description:
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled. Check that you are signed in to GitHub, that the repository exists, and that this computer can reach github.com over HTTPS.",
        }),
      );
      const description = await vi.waitFor(() => {
        const found = document.querySelector<HTMLElement>("[data-slot='toast-description']");
        expect(found).not.toBeNull();
        return found!;
      });

      expect(getComputedStyle(description).whiteSpace).not.toBe("nowrap");
      const lineHeight = Number.parseFloat(getComputedStyle(description).lineHeight);
      expect(description.getBoundingClientRect().height).toBeGreaterThan(lineHeight * 1.5);
      // Every line is on screen: nothing clamped or scrolled out of view.
      expect(description.scrollHeight).toBeLessThanOrEqual(description.clientHeight + 1);
    } finally {
      await mounted.unmount();
    }
  });

  it("puts a notice's buttons under its words, not beside them", async () => {
    const mounted = await render(
      <ToastProvider>
        <div>conversation</div>
      </ToastProvider>,
    );

    try {
      toastManager.add({
        type: "info",
        title: "Agent wants to visit facpmanuals.com",
        description: 'In "Analyze Trial Conversions and AI Logs".',
        timeout: 0,
        actionProps: { children: "Allow site" },
        data: { secondaryActionProps: { children: "Show" } },
      });
      const slot = (name: string) => {
        const found = document.querySelector<HTMLElement>(`[data-slot='${name}']`);
        expect(found).not.toBeNull();
        return found!;
      };
      const [title, description, action] = await vi.waitFor(
        () => [slot("toast-title"), slot("toast-description"), slot("toast-action")] as const,
      );

      // The words keep the whole width: neither is cut short.
      for (const words of [title, description]) {
        expect(words.scrollWidth).toBeLessThanOrEqual(words.clientWidth + 1);
      }
      expect(action.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        description.getBoundingClientRect().bottom,
      );
    } finally {
      await mounted.unmount();
    }
  });

  it("starts a notice's clock only once it gets a slot in the stack", async () => {
    setPageFocus(true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const mounted = await render(
      <ToastProvider>
        <div>conversation</div>
      </ToastProvider>,
    );
    const drawnTitles = () =>
      Array.from(document.querySelectorAll("[data-slot='toast-title']"), (el) => el.textContent);

    try {
      for (const title of ["Oldest", "Second", "Third", "Newest"]) {
        toastManager.add({ type: "success", title });
      }
      await vi.waitFor(() => expect(drawnTitles()).toEqual(["Newest", "Third", "Second"]));

      // The three drawn notices run out; the held-back one only now appears,
      // with its full five seconds still ahead of it.
      await vi.advanceTimersByTimeAsync(5_100);
      await vi.waitFor(() => expect(drawnTitles()).toContain("Oldest"));
      await vi.advanceTimersByTimeAsync(4_000);
      const oldest = Array.from(document.querySelectorAll("[data-slot='toast-title']")).find(
        (el) => el.textContent === "Oldest",
      );
      expect(oldest).toBeDefined();
      expect(oldest!.closest("[data-ending-style]")).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps a notice's clock running while focus is in the desktop app's browser panel", async () => {
    // Focus inside a browser panel (<webview>) reads as the page losing it,
    // while the app window, which the desktop bridge asks, still has it.
    setPageFocus(false);
    window.desktopBridge = {
      isWindowFocused: () => true,
      onWindowFocusChange: () => () => {},
    } as unknown as DesktopBridge;
    onTestFinished(() => {
      Reflect.deleteProperty(window, "desktopBridge");
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const mounted = await render(
      <ToastProvider>
        <div>conversation</div>
      </ToastProvider>,
    );
    const liveTitles = () =>
      Array.from(document.querySelectorAll("[data-slot='toast-title']"))
        .filter((el) => el.closest("[data-ending-style]") === null)
        .map((el) => el.textContent);

    try {
      toastManager.add({ type: "success", title: "Link copied" });
      await vi.waitFor(() => expect(liveTitles()).toEqual(["Link copied"]));

      await vi.advanceTimersByTimeAsync(5_100);
      await vi.waitFor(() => expect(liveTitles()).toEqual([]));
    } finally {
      await mounted.unmount();
    }
  });

  it("holds every clock while the pointer is on the stack", async () => {
    // In front, so the hold below is the pointer's and not a stopped clock's.
    setPageFocus(true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const mounted = await render(
      <ToastProvider>
        <div>conversation</div>
      </ToastProvider>,
    );

    try {
      toastManager.add({ type: "success", title: "Path copied" });
      const root = await vi.waitFor(() => {
        const found = document.querySelector<HTMLElement>("[data-slot='toast-viewport'] > *");
        expect(found).not.toBeNull();
        return found!;
      });
      root.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      root.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      await vi.waitFor(() => expect(root.hasAttribute("data-expanded")).toBe(true));

      await vi.advanceTimersByTimeAsync(8_000);
      expect(root.isConnected).toBe(true);
      expect(root.hasAttribute("data-ending-style")).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });
});
