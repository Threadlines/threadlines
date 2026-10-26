import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { showOnScreenKeyboard } from "../../hooks/useOnScreenKeyboardInset.browser-harness";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "./dialog";

const PHONE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1_600, height: 1_300 };
const KEYBOARD_HEIGHT = 336;

const popupRect = () =>
  document.querySelector<HTMLElement>('[data-slot="dialog-popup"]')?.getBoundingClientRect();

describe("Dialog", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
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
});
