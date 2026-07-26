import { describe, expect, it } from "vite-plus/test";

import { makeBrowserTab, nextActiveTabId, steppedZoom, type BrowserTab } from "./browserPanelStore";

function tabs(count: number): BrowserTab[] {
  return Array.from({ length: count }, () => makeBrowserTab());
}

describe("nextActiveTabId", () => {
  it("keeps the active tab when a different one closes", () => {
    const [a, b, c] = tabs(3) as [BrowserTab, BrowserTab, BrowserTab];

    expect(nextActiveTabId([a, b, c], a.id, b.id)).toBe(b.id);
  });

  it("walks right when the active tab closes", () => {
    const [a, b, c] = tabs(3) as [BrowserTab, BrowserTab, BrowserTab];

    expect(nextActiveTabId([a, b, c], b.id, b.id)).toBe(c.id);
  });

  it("falls back to the left at the end of the strip", () => {
    const [a, b, c] = tabs(3) as [BrowserTab, BrowserTab, BrowserTab];

    expect(nextActiveTabId([a, b, c], c.id, c.id)).toBe(b.id);
  });

  it("reports nothing left when the last tab closes", () => {
    const [only] = tabs(1) as [BrowserTab];

    expect(nextActiveTabId([only], only.id, only.id)).toBeNull();
  });
});

describe("steppedZoom", () => {
  it("moves to the next familiar step rather than drifting", () => {
    expect(steppedZoom(1, 1)).toBe(1.1);
    expect(steppedZoom(1, -1)).toBe(0.9);
    expect(steppedZoom(1.1, 1)).toBe(1.25);
  });

  it("stops at the ends instead of running away", () => {
    expect(steppedZoom(2, 1)).toBe(2);
    expect(steppedZoom(0.5, -1)).toBe(0.5);
  });

  it("snaps a value between steps onto the grid", () => {
    expect(steppedZoom(1.05, 1)).toBe(1.1);
    expect(steppedZoom(1.05, -1)).toBe(1);
  });
});
