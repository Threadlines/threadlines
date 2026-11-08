import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { showOnScreenKeyboard } from "../../hooks/useOnScreenKeyboardInset.browser-harness";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "./dialog";
import { nextFrames, readAfterEachPaint } from "../../lib/frameProbe.browser-harness";
import { resetTestPage } from "../../lib/testPage.browser-harness";
import { publishMainAreaEndInset, publishMainAreaStart } from "../../mainAreaLayout";

const PHONE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1_600, height: 1_300 };
const KEYBOARD_HEIGHT = 336;

const popupRect = () =>
  document.querySelector<HTMLElement>('[data-slot="dialog-popup"]')?.getBoundingClientRect();

describe("Dialog", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    publishMainAreaStart(0);
    publishMainAreaEndInset(0);
    await resetTestPage();
    await page.viewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
  });

  it("lifts a phone's bottom sheet above an on-screen keyboard that covers the page", async () => {
    await page.viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height);
    const mounted = await render(
      <Dialog open>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Connect to a computer</DialogTitle>
          </DialogHeader>
          <input aria-label="Code" className="m-6" />
        </DialogPopup>
      </Dialog>,
    );

    try {
      await vi.waitFor(() => {
        expect(popupRect()?.bottom).toBeCloseTo(window.innerHeight, 0);
      });

      showOnScreenKeyboard({ height: KEYBOARD_HEIGHT, pageScrolledUpBy: 0 });

      await vi.waitFor(() => {
        expect(popupRect()?.bottom).toBeCloseTo(window.innerHeight - KEYBOARD_HEIGHT, 0);
      });
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps a tall sheet inside what's visible when Safari scrolls the page up for the keyboard", async () => {
    await page.viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height);
    const mounted = await render(
      <Dialog open>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Connect to a computer</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="h-[1200px]" />
          </DialogPanel>
        </DialogPopup>
      </Dialog>,
    );

    try {
      const pageScrolledUpBy = 150;
      showOnScreenKeyboard({ height: KEYBOARD_HEIGHT, pageScrolledUpBy });
      // What's visible runs from the scrolled-up top to the keyboard's top.
      const visibleBottom = pageScrolledUpBy + window.innerHeight - KEYBOARD_HEIGHT;

      await vi.waitFor(() => {
        const rect = popupRect();
        // The sheet keeps its 3rem gap below the top of what's visible.
        expect(rect?.top).toBeCloseTo(pageScrolledUpBy + 48, 0);
        expect(rect?.bottom).toBeCloseTo(visibleBottom, 0);
      });
    } finally {
      await mounted.unmount();
    }
  });

  it("centers over the page beside the sidebar and the right panel, never past the window's edge", async () => {
    await page.viewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
    // The page runs from the end of a 400px rail and list to a 300px right panel.
    publishMainAreaStart(400);
    publishMainAreaEndInset(300);
    const mounted = await render(
      <Dialog open>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Rename this computer</DialogTitle>
          </DialogHeader>
        </DialogPopup>
      </Dialog>,
    );
    const popupCenter = () => {
      const rect = popupRect();
      return rect ? (rect.left + rect.right) / 2 : null;
    };

    try {
      await vi.waitFor(() => {
        expect(popupCenter()).toBeCloseTo((400 + DESKTOP_VIEWPORT.width - 300) / 2, 0);
      });

      // A page narrower than the dialog: it stops 1rem short of the window's edge.
      publishMainAreaStart(DESKTOP_VIEWPORT.width - 200);
      publishMainAreaEndInset(0);
      await vi.waitFor(() => {
        expect(popupRect()?.right).toBeCloseTo(window.innerWidth - 16, 0);
      });

      // The window narrows under it: it goes straight to its new spot rather
      // than gliding there, which would poke past the edge on the way.
      const overhangs: number[] = [];
      const stop = readAfterEachPaint(() => {
        overhangs.push((popupRect()?.right ?? 0) - (window.innerWidth - 16));
      });
      await page.viewport(1_000, DESKTOP_VIEWPORT.height);
      await nextFrames(15);
      stop();
      expect(Math.max(...overhangs)).toBeLessThan(0.5);
      expect(overhangs.at(-1)).toBeCloseTo(0, 0);

      // A phone's bottom sheet spans the screen whatever the page reports.
      await page.viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height);
      publishMainAreaStart(0);
      await vi.waitFor(() => {
        expect(popupRect()?.left).toBeCloseTo(0, 0);
        expect(popupRect()?.right).toBeCloseTo(window.innerWidth, 0);
      });
    } finally {
      await mounted.unmount();
    }
  });
});
