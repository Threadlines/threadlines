import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { RightPanelTabStrip } from "./RightPanelTabStrip";
import type { RightPanelTab } from "../../rightPanelTabs";

const OPEN_TABS: ReadonlyArray<RightPanelTab> = ["sourceControl", "diff", "agents"];

function renderStrip(handlers: {
  onSelectTab: (tab: RightPanelTab) => void;
  onReorderTab: (tab: RightPanelTab, toIndex: number) => void;
}) {
  return render(
    <div style={{ width: 480 }}>
      <RightPanelTabStrip
        openTabs={OPEN_TABS}
        availableTabs={OPEN_TABS}
        activeTab="sourceControl"
        onSelectTab={handlers.onSelectTab}
        onCloseTab={vi.fn()}
        onReorderTab={handlers.onReorderTab}
      />
    </div>,
  );
}

function tabElement(tab: RightPanelTab): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-right-panel-tab="${tab}"]`);
  expect(element, `Unable to find the ${tab} tab.`).not.toBeNull();
  return element!;
}

function pointer(type: string, clientX: number): PointerEvent {
  return new PointerEvent(type, { bubbles: true, button: 0, clientX, pointerId: 1 });
}

describe("RightPanelTabStrip drag reorder", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("drags the first tab all the way to the last slot and swallows the trailing click", async () => {
    const onSelectTab = vi.fn();
    const onReorderTab = vi.fn();
    const mounted = await renderStrip({ onSelectTab, onReorderTab });

    try {
      const source = tabElement("sourceControl");
      const diff = tabElement("diff");
      const agents = tabElement("agents");
      const sourceRect = source.getBoundingClientRect();
      const agentsRect = agents.getBoundingClientRect();
      const startX = sourceRect.left + sourceRect.width / 2;
      // The strip's far edge: the full traverse is the case a centre-based
      // swap rule could never complete, so this is the regression to hold.
      const endX = agentsRect.right - 1;

      source.dispatchEvent(pointer("pointerdown", startX));
      window.dispatchEvent(pointer("pointermove", startX + 6));
      window.dispatchEvent(pointer("pointermove", endX));
      // Mid-drag the held tab follows the pointer and its neighbours yield.
      await vi.waitFor(() => {
        expect(source.style.transform).not.toBe("");
        expect(diff.style.transform).not.toBe("");
      });
      window.dispatchEvent(pointer("pointerup", endX));
      // The click the browser fires after a drag must not switch tabs.
      tabElement("sourceControl").querySelector("button")?.click();

      // The commit waits for the settle animation to land the tab first.
      expect(onReorderTab).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(onReorderTab).toHaveBeenCalledWith("sourceControl", 2);
      });
      expect(onReorderTab).toHaveBeenCalledTimes(1);
      expect(onSelectTab).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });

  it("drags an icon-mode active tab by its full-tab ✕ without closing it, and a still press still closes", async () => {
    const onSelectTab = vi.fn();
    const onReorderTab = vi.fn();
    const onCloseTab = vi.fn();
    const mounted = await render(
      // Too narrow for labels, so the strip collapses to icons and the active
      // tab's ✕ covers the whole tab — the only place a drag can start from.
      <div style={{ width: 140 }}>
        <RightPanelTabStrip
          openTabs={OPEN_TABS}
          availableTabs={OPEN_TABS}
          activeTab="sourceControl"
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          onReorderTab={onReorderTab}
        />
      </div>,
    );

    try {
      await vi.waitFor(() => {
        expect(
          document
            .querySelector("[data-right-panel-strip]")
            ?.getAttribute("data-right-panel-strip-mode"),
        ).toBe("icons");
      });
      const close = document.querySelector<HTMLElement>(
        '[data-right-panel-close-tab="sourceControl"]',
      );
      expect(close, "The active icon tab offers its ✕.").not.toBeNull();
      const agentsRect = tabElement("agents").getBoundingClientRect();
      const closeRect = close!.getBoundingClientRect();
      const startX = closeRect.left + closeRect.width / 2;
      const endX = agentsRect.right - 1;

      close!.dispatchEvent(pointer("pointerdown", startX));
      window.dispatchEvent(pointer("pointermove", startX + 6));
      window.dispatchEvent(pointer("pointermove", endX));
      window.dispatchEvent(pointer("pointerup", endX));
      close!.click();

      await vi.waitFor(() => {
        expect(onReorderTab).toHaveBeenCalledWith("sourceControl", 2);
      });
      expect(onCloseTab).not.toHaveBeenCalled();

      // A press that never travels is still the close it always was.
      close!.dispatchEvent(pointer("pointerdown", startX));
      window.dispatchEvent(pointer("pointerup", startX));
      close!.click();
      expect(onCloseTab).toHaveBeenCalledWith("sourceControl");
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps a plain click a click: below the drag threshold nothing moves and select still fires", async () => {
    const onSelectTab = vi.fn();
    const onReorderTab = vi.fn();
    const mounted = await renderStrip({ onSelectTab, onReorderTab });

    try {
      const agents = tabElement("agents");
      const rect = agents.getBoundingClientRect();
      const x = rect.left + rect.width / 2;

      agents.dispatchEvent(pointer("pointerdown", x));
      window.dispatchEvent(pointer("pointermove", x + 2));
      expect(agents.style.transform).toBe("");
      window.dispatchEvent(pointer("pointerup", x + 2));
      agents.querySelector("button")?.click();

      expect(onSelectTab).toHaveBeenCalledWith("agents");
      // Give the settle timer window a beat to prove no reorder sneaks in.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(onReorderTab).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });
});
