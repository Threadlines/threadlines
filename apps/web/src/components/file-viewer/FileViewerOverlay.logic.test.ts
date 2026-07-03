import { describe, expect, it } from "vitest";

import { resolveCoarseLineSelection } from "./FileViewerOverlay.logic";

describe("resolveCoarseLineSelection", () => {
  it("clears when pierre reports no selection", () => {
    expect(resolveCoarseLineSelection({ start: 3, end: 3 }, null)).toBeNull();
  });

  it("passes multi-line input through untouched (managed drag / restore)", () => {
    expect(resolveCoarseLineSelection(null, { start: 2, end: 6 })).toEqual({ start: 2, end: 6 });
    expect(resolveCoarseLineSelection({ start: 1, end: 1 }, { start: 9, end: 4 })).toEqual({
      start: 9,
      end: 4,
    });
  });

  it("selects a single line on the first tap", () => {
    expect(resolveCoarseLineSelection(null, { start: 5, end: 5 })).toEqual({ start: 5, end: 5 });
  });

  it("extends from the anchor when tapping below the selection", () => {
    expect(resolveCoarseLineSelection({ start: 5, end: 5 }, { start: 9, end: 9 })).toEqual({
      start: 5,
      end: 9,
    });
  });

  it("extends into a reversed range when tapping above the anchor", () => {
    expect(resolveCoarseLineSelection({ start: 5, end: 8 }, { start: 2, end: 2 })).toEqual({
      start: 5,
      end: 2,
    });
  });

  it("keeps the original anchor when re-extending a reversed range", () => {
    expect(resolveCoarseLineSelection({ start: 5, end: 2 }, { start: 11, end: 11 })).toEqual({
      start: 5,
      end: 11,
    });
  });

  it("clears when tapping inside the selection, including its edges", () => {
    expect(resolveCoarseLineSelection({ start: 4, end: 8 }, { start: 6, end: 6 })).toBeNull();
    expect(resolveCoarseLineSelection({ start: 4, end: 8 }, { start: 4, end: 4 })).toBeNull();
    expect(resolveCoarseLineSelection({ start: 4, end: 8 }, { start: 8, end: 8 })).toBeNull();
    expect(resolveCoarseLineSelection({ start: 8, end: 4 }, { start: 5, end: 5 })).toBeNull();
  });

  it("clears when tapping the only selected line", () => {
    expect(resolveCoarseLineSelection({ start: 7, end: 7 }, { start: 7, end: 7 })).toBeNull();
  });

  it("preserves selection sides when extending", () => {
    expect(
      resolveCoarseLineSelection({ start: 3, end: 3, side: "additions" }, { start: 6, end: 6 }),
    ).toEqual({ start: 3, end: 6, side: "additions" });
  });
});
