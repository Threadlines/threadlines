import { describe, expect, it } from "vite-plus/test";

import { splitMarkdownBlocks } from "./ChatMarkdown.tsx";

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
