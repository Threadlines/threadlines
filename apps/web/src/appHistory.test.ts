import { describe, expect, it } from "vite-plus/test";

import { nextHistoryPosition } from "./appHistory";

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
