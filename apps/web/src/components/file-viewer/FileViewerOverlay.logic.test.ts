import { describe, expect, it } from "vitest";

import {
  countRenderableTextLines,
  formatRevealLineNoticeLabel,
  formatSelectedLineRangeLabel,
  resolveCoarseLineSelection,
  resolveRevealLineRange,
  resolveRevealLineTarget,
} from "./FileViewerOverlay.logic";

describe("countRenderableTextLines", () => {
  it("does not count a trailing final newline as a rendered extra line", () => {
    expect(countRenderableTextLines("one\ntwo\nthree\n")).toBe(3);
    expect(countRenderableTextLines("one\ntwo\nthree")).toBe(3);
  });

  it("keeps empty files addressable as one line", () => {
    expect(countRenderableTextLines("")).toBe(1);
  });
});

describe("resolveRevealLineRange", () => {
  it("clamps line targets into the rendered file range", () => {
    expect(resolveRevealLineRange({ line: 42, totalLines: 100 })).toEqual({ start: 42, end: 42 });
    expect(resolveRevealLineRange({ line: 0, totalLines: 100 })).toEqual({ start: 1, end: 1 });
    expect(resolveRevealLineRange({ line: 120, totalLines: 100 })).toEqual({
      start: 100,
      end: 100,
    });
  });

  it("keeps reveal ranges inclusive and ordered from the target line", () => {
    expect(resolveRevealLineRange({ line: 7, endLine: 11, totalLines: 20 })).toEqual({
      start: 7,
      end: 11,
    });
    expect(resolveRevealLineRange({ line: 7, endLine: 3, totalLines: 20 })).toEqual({
      start: 7,
      end: 7,
    });
    expect(resolveRevealLineRange({ line: 7, endLine: 30, totalLines: 20 })).toEqual({
      start: 7,
      end: 20,
    });
  });
});

describe("formatSelectedLineRangeLabel", () => {
  it("formats single-line and multi-line selections", () => {
    expect(formatSelectedLineRangeLabel({ start: 42, end: 42 })).toBe("L42 selected");
    expect(formatSelectedLineRangeLabel({ start: 42, end: 45 })).toBe("L42-L45 selected");
    expect(formatSelectedLineRangeLabel({ start: 45, end: 42 })).toBe("L42-L45 selected");
  });
});

describe("formatRevealLineNoticeLabel", () => {
  it("explains when a requested line is outside the current file", () => {
    expect(
      formatRevealLineNoticeLabel({
        requestedLine: 87,
      }),
    ).toBe("L87 is not available in this file");
  });
});

describe("resolveRevealLineTarget", () => {
  it("selects valid requested lines", () => {
    expect(resolveRevealLineTarget({ line: 42, totalLines: 100 })).toEqual({
      scrollRange: { start: 42, end: 42 },
      selectedRange: { start: 42, end: 42 },
      notice: null,
    });
  });

  it("scrolls near unavailable requested lines without selecting a replacement line", () => {
    expect(resolveRevealLineTarget({ line: 87, totalLines: 53 })).toEqual({
      scrollRange: { start: 53, end: 53 },
      selectedRange: null,
      notice: { requestedLine: 87 },
    });
  });
});

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
