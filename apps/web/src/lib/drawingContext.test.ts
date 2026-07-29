import { describe, expect, it } from "vitest";

import {
  appendDrawingContextsToPrompt,
  extractTrailingDrawingContexts,
  formatDrawingContextBlock,
  formatDrawingDescriptor,
  formatParsedDrawingDescriptor,
  type DrawingContext,
} from "./drawingContext";
import type { PickedElementContext } from "./pickedElementContext";

const element = (role: string, name: string, selector: string): PickedElementContext => ({
  note: null,
  styleChanges: [],
  tagName: "section",
  role,
  name,
  selector,
  text: null,
  width: 200,
  height: 100,
  url: "http://localhost:3000/",
});

const drawing = (overrides: Partial<DrawingContext> = {}): DrawingContext => ({
  note: "this is misaligned",
  imageDataUrl: "data:image/png;base64,AAAA",
  url: "http://localhost:3000/",
  elements: [],
  ...overrides,
});

describe("formatDrawingDescriptor", () => {
  it("names the element when a stroke went round exactly one", () => {
    expect(formatDrawingDescriptor(drawing({ elements: [element("region", "Alpha", ".a")] }))).toBe(
      'Drawing · region "Alpha"',
    );
  });

  it("counts them when there are several", () => {
    expect(
      formatDrawingDescriptor(
        drawing({ elements: [element("region", "Alpha", ".a"), element("region", "Beta", ".b")] }),
      ),
    ).toBe("Drawing · 2 elements");
  });

  it("says only what it is when the strokes enclosed nothing", () => {
    // An arrow or a sketch. The picture is the whole message, and claiming an
    // element here would be inventing one.
    expect(formatDrawingDescriptor(drawing())).toBe("Drawing");
  });
});

describe("formatDrawingContextBlock", () => {
  it("carries what the picture cannot and says the image is a drawing", () => {
    const block = formatDrawingContextBlock(
      drawing({ elements: [element("region", "Alpha", "#alpha")] }),
    );

    expect(block).toContain("note: this is misaligned");
    expect(block).toContain("url: http://localhost:3000/");
    expect(block).toContain('circled: region "Alpha" (#alpha)');
    // Without this an agent tries to find the strokes in the source.
    expect(block).toContain("screenshot of this page with the user's drawing on top");
  });

  it("claims nothing was circled when nothing was", () => {
    expect(formatDrawingContextBlock(drawing())).not.toContain("circled:");
  });

  it("omits the note when there is none", () => {
    expect(formatDrawingContextBlock(drawing({ note: null }))).not.toContain("note:");
  });
});

describe("appendDrawingContextsToPrompt", () => {
  it("leaves the prompt alone when nothing was drawn", () => {
    expect(appendDrawingContextsToPrompt("fix the header", [])).toBe("fix the header");
  });

  it("appends one block per drawing", () => {
    const prompt = appendDrawingContextsToPrompt("fix this", [drawing(), drawing({ note: null })]);
    expect(prompt.match(/<drawing>/g)).toHaveLength(2);
    expect(prompt).toContain("fix this");
  });
});

describe("extractTrailingDrawingContexts", () => {
  it("reads the appended blocks back without the screenshot sentence leaking in", () => {
    const prompt = appendDrawingContextsToPrompt("fix this", [
      drawing({
        note: "make it like this\nbut gold",
        elements: [element("region", "Alpha", "#alpha")],
      }),
      drawing({ note: null }),
    ]);

    expect(extractTrailingDrawingContexts(prompt)).toEqual({
      promptText: "fix this",
      contexts: [
        {
          note: "make it like this\nbut gold",
          url: "http://localhost:3000/",
          circled: ['region "Alpha" (#alpha)'],
        },
        { note: null, url: "http://localhost:3000/", circled: [] },
      ],
    });
  });

  it("leaves a prompt without blocks untouched", () => {
    expect(extractTrailingDrawingContexts("plain question")).toEqual({
      promptText: "plain question",
      contexts: [],
    });
  });
});

describe("formatParsedDrawingDescriptor", () => {
  it("counts circled elements without pretending to still know their names", () => {
    expect(formatParsedDrawingDescriptor({ note: null, url: "", circled: [] })).toBe("Drawing");
    expect(formatParsedDrawingDescriptor({ note: null, url: "", circled: ["a"] })).toBe(
      "Drawing · 1 element",
    );
    expect(formatParsedDrawingDescriptor({ note: null, url: "", circled: ["a", "b"] })).toBe(
      "Drawing · 2 elements",
    );
  });
});
