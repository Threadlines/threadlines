import { describe, expect, it } from "vite-plus/test";

import {
  analyzeSearchText,
  buildSearchTextSnippet,
  compareRankedSearchResults,
  insertRankedSearchResult,
  normalizeSearchQuery,
  parseSearchQuery,
  searchQueryHighlightValues,
  scoreQueryMatch,
  scoreSubsequenceMatch,
} from "./searchRanking.ts";

describe("parseSearchQuery", () => {
  it("keeps quoted phrases intact while splitting unquoted required terms", () => {
    expect(parseSearchQuery(`testing "how there" now`)).toEqual({
      clauses: [
        { value: "testing", quoted: false },
        { value: "how there", quoted: true },
        { value: "now", quoted: false },
      ],
      phrase: "testing how there now",
    });
  });

  it("supports escaped and unfinished quotes without throwing", () => {
    expect(parseSearchQuery(`say "hello \\"there\\"`)).toEqual({
      clauses: [
        { value: "say", quoted: false },
        { value: `hello "there"`, quoted: true },
      ],
      phrase: `say hello "there"`,
    });
  });
});

describe("analyzeSearchText", () => {
  it("requires every clause and ranks phrase, ordered, then unordered matches", () => {
    const phrase = analyzeSearchText("testing how there works", "testing how there");
    const ordered = analyzeSearchText("testing can explain how we got there", "testing how there");
    const unordered = analyzeSearchText("there is a testing note about how", "testing how there");

    expect(phrase?.kind).toBe("exact-phrase");
    expect(ordered?.kind).toBe("ordered");
    expect(unordered?.kind).toBe("unordered");
    expect(phrase!.score).toBeLessThan(ordered!.score);
    expect(ordered!.score).toBeLessThan(unordered!.score);
    expect(analyzeSearchText("testing only", "testing how there")).toBeNull();
  });

  it("requires quoted clauses to occur as an exact phrase", () => {
    expect(analyzeSearchText("testing how there works", `testing "how there"`)).not.toBeNull();
    expect(analyzeSearchText("testing how we got there", `testing "how there"`)).toBeNull();
  });
});

describe("search snippets and highlights", () => {
  it("uses compact fragments that visibly account for scattered query terms", () => {
    const text = `testing ${"filler ".repeat(40)}how ${"more ".repeat(40)}there`;
    const snippet = buildSearchTextSnippet(text, "testing how there", { maxLength: 100 });

    expect(snippet).toContain("testing");
    expect(snippet).toContain("how");
    expect(snippet).toContain("there");
    expect(snippet.length).toBeLessThan(150);
  });

  it("keeps unordered fragments in their original document order", () => {
    const text = `there ${"filler ".repeat(40)}testing ${"more ".repeat(40)}how`;
    const snippet = buildSearchTextSnippet(text, "testing how there", { maxLength: 100 });

    expect(snippet.indexOf("there")).toBeLessThan(snippet.indexOf("testing"));
    expect(snippet.indexOf("testing")).toBeLessThan(snippet.indexOf("how"));
    expect(snippet).not.toContain("… …");
  });

  it("prefers the full phrase while retaining word fallbacks for split renderers", () => {
    expect(searchQueryHighlightValues(`testing "how there"`)).toEqual([
      "testing how there",
      "how there",
      "testing",
      "there",
      "how",
    ]);
  });
});

describe("normalizeSearchQuery", () => {
  it("trims and lowercases queries", () => {
    expect(normalizeSearchQuery("  UI  ")).toBe("ui");
  });

  it("can strip leading trigger characters", () => {
    expect(normalizeSearchQuery("  $ui", { trimLeadingPattern: /^\$+/ })).toBe("ui");
  });
});

describe("scoreQueryMatch", () => {
  it("prefers exact matches over broader contains matches", () => {
    expect(
      scoreQueryMatch({
        value: "ui",
        query: "ui",
        exactBase: 0,
        prefixBase: 10,
        includesBase: 20,
      }),
    ).toBe(0);

    expect(
      scoreQueryMatch({
        value: "building native ui",
        query: "ui",
        exactBase: 0,
        prefixBase: 10,
        boundaryBase: 20,
        includesBase: 30,
      }),
    ).toBeGreaterThan(0);
  });

  it("treats boundary matches as stronger than generic contains matches", () => {
    const boundaryScore = scoreQueryMatch({
      value: "gh-fix-ci",
      query: "fix",
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 20,
      includesBase: 30,
      boundaryMarkers: ["-"],
    });
    const containsScore = scoreQueryMatch({
      value: "highfixci",
      query: "fix",
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 20,
      includesBase: 30,
      boundaryMarkers: ["-"],
    });

    expect(boundaryScore).not.toBeNull();
    expect(containsScore).not.toBeNull();
    expect(boundaryScore!).toBeLessThan(containsScore!);
  });
});

describe("scoreSubsequenceMatch", () => {
  it("scores tighter subsequences ahead of looser ones", () => {
    const compact = scoreSubsequenceMatch("ghfixci", "gfc");
    const spread = scoreSubsequenceMatch("github-fix-ci", "gfc");

    expect(compact).not.toBeNull();
    expect(spread).not.toBeNull();
    expect(compact!).toBeLessThan(spread!);
  });
});

describe("insertRankedSearchResult", () => {
  it("keeps the best-ranked candidates within the limit", () => {
    const ranked = [
      { item: "b", score: 20, tieBreaker: "b" },
      { item: "d", score: 40, tieBreaker: "d" },
    ];

    insertRankedSearchResult(ranked, { item: "a", score: 10, tieBreaker: "a" }, 2);
    insertRankedSearchResult(ranked, { item: "c", score: 30, tieBreaker: "c" }, 2);

    expect(ranked.map((entry) => entry.item)).toEqual(["a", "b"]);
    expect(compareRankedSearchResults(ranked[0]!, ranked[1]!)).toBeLessThan(0);
  });
});
