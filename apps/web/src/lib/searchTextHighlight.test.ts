import { describe, expect, it } from "vite-plus/test";

import {
  findSearchTextHighlightSpans,
  splitSearchTextHighlightSegments,
} from "./searchTextHighlight";

describe("searchTextHighlight", () => {
  it("splits case-insensitive substring matches without changing visible text", () => {
    expect(
      splitSearchTextHighlightSegments("Before TESTING after testing.", "testing").map(
        ({ text, highlighted }) => ({ text, highlighted }),
      ),
    ).toEqual([
      { text: "Before ", highlighted: false },
      { text: "TESTING", highlighted: true },
      { text: " after ", highlighted: false },
      { text: "testing", highlighted: true },
      { text: ".", highlighted: false },
    ]);
  });

  it("highlights each search term and safely handles regular-expression punctuation", () => {
    expect(
      splitSearchTextHighlightSegments("Use nav.bar during UI testing", "nav.bar testing").map(
        ({ text, highlighted }) => ({ text, highlighted }),
      ),
    ).toEqual([
      { text: "Use ", highlighted: false },
      { text: "nav.bar", highlighted: true },
      { text: " during UI ", highlighted: false },
      { text: "testing", highlighted: true },
    ]);
  });

  it("highlights a contiguous multiword query as one visual phrase", () => {
    expect(
      splitSearchTextHighlightSegments("Before testing   how there after", "testing how there").map(
        ({ text, highlighted }) => ({ text, highlighted }),
      ),
    ).toEqual([
      { text: "Before ", highlighted: false },
      { text: "testing   how there", highlighted: true },
      { text: " after", highlighted: false },
    ]);
  });

  it("removes quote syntax while highlighting an exact quoted phrase", () => {
    expect(
      splitSearchTextHighlightSegments("Before testing how there after", `"testing how there"`).map(
        ({ text, highlighted }) => ({ text, highlighted }),
      ),
    ).toEqual([
      { text: "Before ", highlighted: false },
      { text: "testing how there", highlighted: true },
      { text: " after", highlighted: false },
    ]);
  });

  it("returns no spans for an empty query", () => {
    expect(findSearchTextHighlightSpans("testing", "  ")).toEqual([]);
  });
});
