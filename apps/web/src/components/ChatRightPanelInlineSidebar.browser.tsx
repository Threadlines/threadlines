import "../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { ChatRightPanelInlineSidebar } from "./ChatRightPanelInlineSidebar";
import { RIGHT_PANEL_INSET_CSS_VAR } from "../rightPanelLayout";

function readPanelInset(): string {
  return document.documentElement.style.getPropertyValue(RIGHT_PANEL_INSET_CSS_VAR);
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
  afterEach(() => {
    document.documentElement.style.removeProperty(RIGHT_PANEL_INSET_CSS_VAR);
    document.body.innerHTML = "";
  });

  // Toasts and other body-portaled overlays are fixed to the viewport, so the
  // layout cannot push them off the panel. They read this instead.
  it("publishes how much of the right edge the open panel takes", async () => {
    const mounted = await renderSidebar(true);

    try {
      const slot = document.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']");
      expect(slot).not.toBeNull();
      const slotWidth = Math.round(slot!.getBoundingClientRect().width);
      expect(slotWidth).toBeGreaterThan(0);
      await vi.waitFor(() => {
        expect(readPanelInset()).toBe(`${slotWidth}px`);
      });
    } finally {
      await mounted.unmount();
    }
  });

  it("reports no inset while the panel is closed, and clears it on unmount", async () => {
    const mounted = await renderSidebar(false);

    try {
      await vi.waitFor(() => {
        expect(readPanelInset()).toBe("0px");
      });
    } finally {
      await mounted.unmount();
    }

    expect(readPanelInset()).toBe("0px");
  });
});
