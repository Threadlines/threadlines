import "../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { ChatRightPanelInlineSidebar } from "./ChatRightPanelInlineSidebar";
import { publishMainAreaEndInset, readMainAreaBounds } from "../mainAreaLayout";
import { resetTestPage } from "../lib/testPage.browser-harness";

function readPanelInset(): number {
  return readMainAreaBounds().endInset;
}

function renderSidebar(open: boolean) {
  return render(
    <div style={{ boxSizing: "border-box", display: "flex", height: 480, width: 1200 }}>
      <div style={{ flex: 1, minWidth: 0 }}>conversation</div>
      <ChatRightPanelInlineSidebar open={open} onClose={vi.fn()} onRequestOpen={vi.fn()}>
        <div style={{ height: "100%" }}>panel body</div>
      </ChatRightPanelInlineSidebar>
    </div>,
  );
}

describe("ChatRightPanelInlineSidebar", () => {
  afterEach(async () => {
    publishMainAreaEndInset(0);
    await resetTestPage();
  });

  // Toasts, dialogs and other body-portaled layers are fixed to the window, so
  // the layout cannot push them off the panel. They read this instead.
  it("publishes how much of the right edge the open panel takes, and clears it on unmount", async () => {
    const mounted = await renderSidebar(true);

    try {
      const slot = document.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']");
      expect(slot).not.toBeNull();
      const slotWidth = Math.round(slot!.getBoundingClientRect().width);
      expect(slotWidth).toBeGreaterThan(0);
      await vi.waitFor(() => {
        expect(readPanelInset()).toBe(slotWidth);
      });
    } finally {
      await mounted.unmount();
    }

    expect(readPanelInset()).toBe(0);
  });

  it("reports no inset while the panel is closed", async () => {
    // What an open panel on the previous thread left behind.
    publishMainAreaEndInset(320);
    const mounted = await renderSidebar(false);

    try {
      await vi.waitFor(() => {
        expect(readPanelInset()).toBe(0);
      });
    } finally {
      await mounted.unmount();
    }
  });
});
