import { describe, expect, it } from "vite-plus/test";

import {
  resolveRowSwipeIntent,
  resolveRowSwipeOffset,
  rowSwipeCommitDistance,
} from "./useRowSwipe";
import { TOUCH_HOLD_SLOP_PX } from "./useTouchHoldMenu";

const BOTH = { leading: true, trailing: true };

describe("resolveRowSwipeIntent", () => {
  it("waits out the hold's slop, leaves vertical moves to the scroll, and takes sideways ones it has an action for", () => {
    // Inside the slop nothing is decided, so a hold and a swipe never both start.
    expect(resolveRowSwipeIntent({ dx: TOUCH_HOLD_SLOP_PX, dy: 0, ...BOTH })).toBe("pending");
    // A diagonal that is mostly down is a scroll; a tie goes to the scroll too.
    expect(resolveRowSwipeIntent({ dx: 14, dy: 20, ...BOTH })).toBe("pass");
    expect(resolveRowSwipeIntent({ dx: 15, dy: 15, ...BOTH })).toBe("pass");
    expect(resolveRowSwipeIntent({ dx: -20, dy: 6, ...BOTH })).toBe("swipe");
    // A side with no action is not the row's to take.
    expect(resolveRowSwipeIntent({ dx: -20, dy: 0, leading: true, trailing: false })).toBe("pass");
    expect(resolveRowSwipeIntent({ dx: 20, dy: 0, leading: true, trailing: false })).toBe("swipe");
  });
});

describe("resolveRowSwipeOffset", () => {
  it("follows the finger, resists near the far edge, stops at the row's width, and never opens a side with no action", () => {
    const width = 300;
    expect(resolveRowSwipeOffset({ travel: -100, width, ...BOTH })).toBe(-100);
    // Past 70% of the width the row moves at a quarter of the finger's pace.
    expect(resolveRowSwipeOffset({ travel: 250, width, ...BOTH })).toBe(210 + 40 * 0.25);
    expect(resolveRowSwipeOffset({ travel: 5000, width, ...BOTH })).toBe(300);
    expect(resolveRowSwipeOffset({ travel: 80, width, leading: false, trailing: true })).toBe(0);
  });

  it("asks for a real swipe before letting go runs the action, even on a narrow row", () => {
    expect(rowSwipeCommitDistance(400)).toBe(160);
    expect(rowSwipeCommitDistance(150)).toBe(96);
  });
});
