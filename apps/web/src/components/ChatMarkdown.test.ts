import { describe, expect, it } from "vite-plus/test";

import { splitMarkdownBlocks } from "./ChatMarkdown.tsx";
import {
  parseCodexInlineVisualizations,
  stripCodexInlineVisualizationDirectives,
} from "../lib/codexInlineVisualization";

describe("splitMarkdownBlocks", () => {
  it("returns no blocks for empty text", () => {
    expect(splitMarkdownBlocks("")).toEqual([]);
    expect(splitMarkdownBlocks("\n\n")).toEqual([]);
  });

  it("splits paragraphs at blank lines", () => {
    expect(splitMarkdownBlocks("one\n\ntwo\n\n\nthree")).toEqual(["one", "two", "three"]);
  });

  it("keeps multi-line constructs without blank lines together", () => {
    expect(splitMarkdownBlocks("- a\n- b\n- c\n\nnext")).toEqual(["- a\n- b\n- c", "next"]);
  });

  it("does not split on blank lines inside fenced code blocks", () => {
    const text = "intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\noutro";
    expect(splitMarkdownBlocks(text)).toEqual([
      "intro",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```",
      "outro",
    ]);
  });

  it("treats a longer closing fence as closing and ignores shorter inner fences", () => {
    const text = "````md\nexample:\n\n```ts\ncode\n```\n\ndone\n````\n\nafter";
    expect(splitMarkdownBlocks(text)).toEqual([
      "````md\nexample:\n\n```ts\ncode\n```\n\ndone\n````",
      "after",
    ]);
  });

  it("keeps an unterminated fence in a single trailing block", () => {
    const text = "before\n\n```ts\nstill\n\nstreaming";
    expect(splitMarkdownBlocks(text)).toEqual(["before", "```ts\nstill\n\nstreaming"]);
  });

  it("supports tilde fences and indented fence markers", () => {
    const text = "a\n\n   ~~~py\nx = 1\n\ny = 2\n~~~\n\nb";
    expect(splitMarkdownBlocks(text)).toEqual(["a", "   ~~~py\nx = 1\n\ny = 2\n~~~", "b"]);
  });

  it("round-trips content so no text is lost", () => {
    const text = "# h\n\npara one\n\n```js\nlet x;\n\nlet y;\n```\n\n- item\n- item2";
    const blocks = splitMarkdownBlocks(text);
    expect(blocks.join("\n\n")).toBe(text);
  });
});

describe("Codex inline visualization directives", () => {
  it("extracts exact standalone directives between markdown sections", () => {
    expect(
      parseCodexInlineVisualizations(
        'Before\n\n::codex-inline-vis{file="connection-map.html"}\n\nAfter',
      ),
    ).toEqual([
      { type: "markdown", key: "markdown:0", text: "Before\n" },
      { type: "visualization", key: "visualization:8", file: "connection-map.html" },
      { type: "markdown", key: "markdown:55", text: "\nAfter" },
    ]);
  });

  it("leaves directives inside code fences and malformed filenames as markdown", () => {
    const text =
      '```text\n::codex-inline-vis{file="inside-code.html"}\n```\n\n::codex-inline-vis{file="../escape.html"}';
    expect(parseCodexInlineVisualizations(text)).toEqual([
      { type: "markdown", key: "markdown:0", text },
    ]);
  });

  it("hides an unfinished final directive while streaming", () => {
    expect(
      parseCodexInlineVisualizations("Done\n\n::codex-inline-vis{file=", {
        isStreaming: true,
      }),
    ).toEqual([{ type: "markdown", key: "markdown:0", text: "Done\n" }]);
  });

  it("removes rendered directives from copied assistant text", () => {
    expect(
      stripCodexInlineVisualizationDirectives(
        'Before\n\n::codex-inline-vis{file="connection-map.html"}\n\nAfter',
      ),
    ).toBe("Before\n\nAfter");
  });
});
