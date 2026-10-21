import { describe, expect, it } from "vite-plus/test";

import { initialHistoryPosition, nextHistoryPosition } from "./appHistory";

describe("nextHistoryPosition", () => {
  it("keeps the way forward after going back, and drops it on a new page", () => {
    const start = { index: 0, furthest: 0 };
    const twoPagesIn = nextHistoryPosition(nextHistoryPosition(start, "PUSH", 1), "PUSH", 2);
    const wentBack = nextHistoryPosition(twoPagesIn, "BACK", 1);
    // Back from the third page: forward leads to it again.
    expect(wentBack).toEqual({ index: 1, furthest: 2 });
    // Swapping the page in place (a redirect) leaves that alone.
    expect(nextHistoryPosition(wentBack, "REPLACE", 1)).toEqual({ index: 1, furthest: 2 });
    // Opening somewhere new from there: nothing ahead any more.
    expect(nextHistoryPosition(wentBack, "PUSH", 2)).toEqual({ index: 2, furthest: 2 });
  });
});

describe("initialHistoryPosition", () => {
  it("keeps the way forward across a reload made after going back", () => {
    // Three pages in, back to the second, then the window reloads there.
    expect(initialHistoryPosition(1, 2)).toEqual({ index: 1, furthest: 2 });
    // A fresh window has nothing stored and nothing ahead.
    expect(initialHistoryPosition(0, null)).toEqual({ index: 0, furthest: 0 });
    // A stored value behind the current entry never limits it.
    expect(initialHistoryPosition(3, 1)).toEqual({ index: 3, furthest: 3 });
  });
});
