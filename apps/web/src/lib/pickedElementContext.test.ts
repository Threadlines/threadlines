import { ThreadId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendPickedElementContextsToPrompt,
  extractTrailingPickedElementContexts,
  formatPickedElementDescriptor,
  normalizePickedElementContextDraft,
  pickedElementFromPreview,
  type PickedElementContext,
} from "./pickedElementContext";

const context: PickedElementContext = {
  note: null,
  styleChanges: [],
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

describe("formatPickedElementDescriptor", () => {
  it("describes the element regardless of any note attached to it", () => {
    // The note lives behind the chip now, so the descriptor must stay stable.
    expect(formatPickedElementDescriptor({ ...context, note: "this is misaligned" })).toBe(
      'button "Sign in"',
    );
  });

  it("leads with role and name, which is how you would describe it aloud", () => {
    expect(formatPickedElementDescriptor(context)).toBe('button "Sign in"');
  });

  it("falls back to the element's own words, not its CSS path", () => {
    // A generic section is recognisable by what it says; "#root > div > section"
    // is not something anyone wants to read in a chip.
    expect(
      formatPickedElementDescriptor({
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
    const label = formatPickedElementDescriptor({
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
      formatPickedElementDescriptor({
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
  it("labels style tweaks as proposed, since nothing has touched the source", () => {
    const prompt = appendPickedElementContextsToPrompt("", [
      {
        ...context,
        styleChanges: [{ property: "font-size", from: "16px", to: "18px" }],
      },
    ]);

    expect(prompt).toContain("proposed styles: font-size: 16px → 18px");
  });

  it("says nothing about styles when none were tried", () => {
    expect(appendPickedElementContextsToPrompt("", [context])).not.toContain("proposed styles");
  });

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

describe("extractTrailingPickedElementContexts", () => {
  it("reads the appended blocks back as the contexts they were, in order", () => {
    const first: PickedElementContext = {
      ...context,
      note: "move this\nbelow the heading",
      styleChanges: [{ property: "font-size", from: "16px", to: "18px" }],
    };
    const second: PickedElementContext = {
      ...context,
      role: null,
      name: null,
      selector: "#top > p",
      text: "Facility Services",
      url: "http://localhost:4321/",
    };
    const prompt = appendPickedElementContextsToPrompt("Use that sigil as the favicon", [
      first,
      second,
    ]);

    const extracted = extractTrailingPickedElementContexts(prompt);

    expect(extracted.promptText).toBe("Use that sigil as the favicon");
    expect(extracted.contexts).toEqual([
      // The block omits text when it only repeats the name, so the round trip
      // comes back without it; the descriptor does not need it.
      { ...first, text: null },
      second,
    ]);
  });

  it("leaves a prompt without blocks untouched", () => {
    expect(extractTrailingPickedElementContexts("plain question")).toEqual({
      promptText: "plain question",
      contexts: [],
    });
  });

  it("keeps a block it cannot represent as a chip visible as text", () => {
    const prompt = "look here\n\n<selected_element>\nnote: no selector\n</selected_element>\n";

    expect(extractTrailingPickedElementContexts(prompt)).toEqual({
      promptText: prompt,
      contexts: [],
    });
  });
});

describe("pickedElementFromPreview", () => {
  it("flattens the rect, since only the size is worth carrying", () => {
    expect(
      pickedElementFromPreview({
        note: null,
        styleChanges: [],
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
