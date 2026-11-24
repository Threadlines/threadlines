import { describe, expect, it } from "vite-plus/test";

import {
  ALL_FILTER_GROUP_CAP,
  filterPaletteSearch,
  paletteFilterCounts,
  stepPaletteFilter,
} from "./paletteFilters";
import type { PaletteSearchResult } from "./paletteSearch";

const rows = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({ value: `${prefix}${index}`, tier: 2 as const }));

const RESULT: PaletteSearchResult<string> = {
  sections: [
    { source: "threads", rows: rows("t", 7) },
    { source: "commands", rows: rows("c", 2) },
  ],
  closeMatches: [],
};

describe("filterPaletteSearch", () => {
  it("shows five rows of each kind in All, and the total for its Show all row", () => {
    const { sections } = filterPaletteSearch(RESULT, "all");
    expect(sections.map((section) => [section.source, section.rows.length, section.total])).toEqual(
      [
        ["threads", ALL_FILTER_GROUP_CAP, 7],
        ["commands", 2, 2],
      ],
    );
  });

  it("shows one kind whole under its own filter", () => {
    const { sections } = filterPaletteSearch(RESULT, "threads");
    expect(sections).toHaveLength(1);
    expect(sections[0]!.rows).toHaveLength(7);
  });

  it("offers close matches only to a view that found nothing itself", () => {
    const result: PaletteSearchResult<string> = {
      sections: [{ source: "threads", rows: rows("t", 1) }],
      closeMatches: [{ source: "commands", value: "open-settings" }],
    };
    // All found a thread: nothing to offer instead.
    expect(filterPaletteSearch(result, "all").closeMatches).toEqual([]);
    // The thread doesn't hide the command's close match from Commands.
    expect(filterPaletteSearch(result, "commands").closeMatches).toEqual(["open-settings"]);
    expect(paletteFilterCounts(result)).toMatchObject({ all: 1, threads: 1, commands: 1 });
  });

  it("keeps close matches with their kind's filter", () => {
    const closeMatches: PaletteSearchResult<string>["closeMatches"] = [
      { source: "commands", value: "open-settings" },
      { source: "settings", value: "text-size" },
    ];
    const result = { sections: [], closeMatches };
    expect(filterPaletteSearch(result, "all").closeMatches).toEqual(["open-settings", "text-size"]);
    expect(filterPaletteSearch(result, "settings").closeMatches).toEqual(["text-size"]);
    expect(filterPaletteSearch(result, "threads").closeMatches).toEqual([]);
    expect(paletteFilterCounts(result)).toMatchObject({ all: 2, commands: 1, settings: 1 });
  });
});

describe("paletteFilterCounts", () => {
  it("counts every row a kind found, not just the five All shows", () => {
    expect(paletteFilterCounts(RESULT)).toEqual({
      all: 9,
      threads: 7,
      commands: 2,
      settings: 0,
      projects: 0,
    });
  });
});

describe("stepPaletteFilter", () => {
  it("moves through the filters in order and wraps both ways", () => {
    expect(stepPaletteFilter("all", 1)).toBe("threads");
    expect(stepPaletteFilter("projects", 1)).toBe("all");
    expect(stepPaletteFilter("all", -1)).toBe("projects");
  });
});
