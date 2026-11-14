import "./index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { Popover, PopoverPopup, PopoverTrigger } from "./components/ui/popover";
import { resetTestPage } from "./lib/testPage.browser-harness";

describe("side strips", () => {
  afterEach(async () => {
    document.documentElement.style.removeProperty("--safe-area-right");
    await resetTestPage();
  });

  it("keeps a popup opening beside its button off a strip down the window's right side", async () => {
    // An iPhone Duo's status dock hangs down the right edge of the screen.
    const strip = 85;
    const mounted = await render(
      <Popover>
        <PopoverTrigger className="fixed top-2 right-24">Branch</PopoverTrigger>
        <PopoverPopup className="w-64">Switch branch</PopoverPopup>
      </Popover>,
    );
    const popupRight = () =>
      document.querySelector('[data-slot="popover-popup"]')?.getBoundingClientRect().right;

    try {
      await page.getByRole("button", { name: "Branch" }).click();
      // Too wide to sit centered under its button: it stops just short of the window's edge.
      await vi.waitFor(() => {
        expect(popupRight()).toBeCloseTo(window.innerWidth - 5, 0);
      });

      // The strip appears (the phone unfolds, or turns): the popup moves clear of it.
      document.documentElement.style.setProperty("--safe-area-right", `${strip}px`);
      await vi.waitFor(() => {
        expect(popupRight()).toBeCloseTo(window.innerWidth - strip - 5, 0);
      });
    } finally {
      await mounted.unmount();
    }
  });
});
