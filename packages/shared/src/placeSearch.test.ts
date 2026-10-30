import { describe, expect, it } from "vite-plus/test";

import {
  matchSearchFields,
  parseSearchQuery,
  searchMatchRanges,
  searchWords,
} from "./placeSearch.ts";

const match = (query: string, fields: Parameters<typeof matchSearchFields>[1]) =>
  matchSearchFields(parseSearchQuery(query), fields);

const textSize = {
  title: "Text size",
  keywords: ["font size", "zoom"],
  section: "Terminal",
  page: "General",
  about: "The size of the terminal's text on this device.",
};

describe("settings search matching", () => {
  it("narrows while typing: the last word matches as the start of a word", () => {
    expect(match("te", textSize)).not.toBeNull();
    expect(match("text si", textSize)?.inTitle).toBe(true);
    // Every word has to name the entry.
    expect(match("text color", textSize)).toBeNull();
  });

  it("matches at word starts only", () => {
    const speech = { title: "Speech model", keywords: ["microphone"] };
    expect(match("phone", speech)).toBeNull();
    expect(match("micro", speech)?.keyword).toBe("microphone");
  });

  it("says which everyday word found an entry whose title doesn't", () => {
    expect(match("font size", textSize)).toMatchObject({ inTitle: false, keyword: "font size" });
    expect(match("size", textSize)).toMatchObject({ inTitle: true, keyword: null });
  });

  it("finds a section's rows by the section's name", () => {
    expect(match("terminal", textSize)).not.toBeNull();
  });

  it("lets a page's name narrow a query, never carry it alone", () => {
    const templates = {
      title: "Follow PR templates",
      section: "Text generation",
      page: "Source Control",
    };
    expect(match("source control pr templates", templates)).not.toBeNull();
    expect(match("source control", templates)).toBeNull();
  });

  it("ranks a title read from its start above the same words elsewhere", () => {
    const theme = { title: "Theme", keywords: ["dark mode"] };
    const terminalTheme = { title: "Terminal colors", about: "Follows the app's theme." };
    expect(match("theme", theme)!.score).toBeGreaterThan(match("theme", terminalTheme)!.score);
  });

  it("keeps file names whole and drops finished filler words", () => {
    expect(searchWords("CLAUDE.md, AGENTS.md")).toEqual(["claude.md", "agents.md"]);
    expect(match("claude.md", { title: "Agent Instructions", keywords: ["CLAUDE.md"] })).not.toBe(
      null,
    );
    expect(parseSearchQuery("the theme").words).toEqual(["theme"]);
    // Still being typed: "a" may become "agents".
    expect(parseSearchQuery("rooms a").words).toEqual(["rooms", "a"]);
  });

  it("marks only what was typed, at the start of each word", () => {
    const text = "Delete old archived threads";
    expect(
      searchMatchRanges(text, parseSearchQuery("arch th")).map(({ start, end }) =>
        text.slice(start, end),
      ),
    ).toEqual(["arch", "th"]);
  });
});
