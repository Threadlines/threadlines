import { ThreadId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendPickedElementContextsToPrompt,
  formatPickedElementContextLabel,
  normalizePickedElementContextDraft,
  pickedElementFromPreview,
  type PickedElementContext,
} from "./pickedElementContext";

const context: PickedElementContext = {
  tagName: "button",
  role: "button",
  name: "Sign in",
  selector: "#cta",
  text: "Sign in",
  width: 220,
  height: 60,
  url: "http://localhost:5173/",
};

const draft = {
  ...context,
  id: "pick-1",
  threadId: ThreadId.make("thread-1"),
  createdAt: "2026-07-26T00:00:00.000Z",
};

describe("formatPickedElementContextLabel", () => {
  it("leads with role and name, which is how you would describe it aloud", () => {
    expect(formatPickedElementContextLabel(context)).toBe('button "Sign in"');
  });

  it("falls back to the element's own words, not its CSS path", () => {
    // A generic section is recognisable by what it says; "#root > div > section"
    // is not something anyone wants to read in a chip.
    expect(
      formatPickedElementContextLabel({
        ...context,
        tagName: "section",
        role: null,
        name: null,
        selector: "#root > div > section",
        text: "Pair with this environment. This environment expects a trusted credential.",
      }),
    ).toBe('section · "Pair with this environment…"');
  });

  it("breaks the snippet on a word rather than mid-syllable", () => {
    const label = formatPickedElementContextLabel({
      ...context,
      role: null,
      name: null,
      text: "Supercalifragilistic expialidocious incantation follows here",
    });

    expect(label).not.toContain("Supercalifragilisticexp");
    expect(label.endsWith('…"')).toBe(true);
  });

  it("uses the tag alone when the element has nothing to say", () => {
    expect(
      formatPickedElementContextLabel({
        ...context,
        tagName: "div",
        role: null,
        name: null,
        text: null,
      }),
    ).toBe("div");
  });
});

describe("normalizePickedElementContextDraft", () => {
  it("drops a pick with no selector, since nothing could act on it", () => {
    expect(normalizePickedElementContextDraft({ ...draft, selector: "  " })).toBeNull();
  });

  it("treats blank role and name as absent rather than empty", () => {
    const normalized = normalizePickedElementContextDraft({ ...draft, role: " ", name: " " });

    expect(normalized).toMatchObject({ role: null, name: null });
  });
});

describe("appendPickedElementContextsToPrompt", () => {
  it("appends a block the agent can read without disturbing the message", () => {
    const prompt = appendPickedElementContextsToPrompt("this button is misaligned", [context]);

    expect(prompt).toContain("this button is misaligned");
    expect(prompt).toContain("<selected_element>");
    expect(prompt).toContain("selector: #cta");
    expect(prompt).toContain("role: button");
  });

  it("omits text that only repeats the name", () => {
    expect(appendPickedElementContextsToPrompt("", [context])).not.toContain("text:");
  });

  it("collapses repeat picks of the same element on the same page", () => {
    const prompt = appendPickedElementContextsToPrompt("", [context, { ...context }]);

    expect(prompt.match(/<selected_element>/g)).toHaveLength(1);
  });

  it("keeps the same selector on a different page as its own context", () => {
    const prompt = appendPickedElementContextsToPrompt("", [
      context,
      { ...context, url: "http://localhost:5173/settings" },
    ]);

    expect(prompt.match(/<selected_element>/g)).toHaveLength(2);
  });
});

describe("pickedElementFromPreview", () => {
  it("flattens the rect, since only the size is worth carrying", () => {
    expect(
      pickedElementFromPreview({
        tagName: "a",
        role: "link",
        name: "Docs",
        selector: "nav > a",
        text: null,
        rect: { x: 10, y: 20, width: 80, height: 24 },
        url: "http://localhost:5173/",
      }),
    ).toMatchObject({ width: 80, height: 24, selector: "nav > a" });
  });
});
