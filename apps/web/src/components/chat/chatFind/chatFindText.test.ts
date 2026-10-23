import { describe, expect, it } from "vite-plus/test";

import {
  findableMarkdownBlocks,
  findableUserMessageBlocks,
  markdownFirstLine,
} from "./chatFindText";

const markdown = (
  text: string,
  overrides: Partial<Parameters<typeof findableMarkdownBlocks>[0]> = {},
) =>
  findableMarkdownBlocks({
    text,
    cwd: "/repo",
    skills: [],
    isStreaming: false,
    visualizations: true,
    ...overrides,
  });

describe("findableMarkdownBlocks", () => {
  it("reads links by their words, never their address", () => {
    expect(markdown("See [the docs](https://example.com/guide) now")).toEqual(["See the docs now"]);
  });

  it("reads emphasis, entities and escapes the way they are drawn", () => {
    expect(markdown("hello **world** and AT&amp;T and \\*stars\\*")).toEqual([
      "hello world and AT&T and *stars*",
    ]);
  });

  it("keeps code as written and leaves out the fence's language", () => {
    expect(markdown("```ts\nconst answer = 42;\n```")).toEqual(["const answer = 42;\n"]);
  });

  it("splits text into the blocks the reader sees", () => {
    expect(
      markdown("# Title\n\nPara one\n\n- item a\n- item b\n\n| head |\n| --- |\n| cell |"),
    ).toEqual(["Title", "Para one", "item a", "item b", "head", "cell"]);
  });

  it("shows raw HTML as the text it is", () => {
    expect(markdown("Use a <div> here")).toEqual(["Use a <div> here"]);
  });

  it("closes a streaming tail's open markers before reading it", () => {
    expect(markdown("This is **bold", { isStreaming: true })).toEqual(["This is bold"]);
  });

  it("reads file references by their chip's label", () => {
    expect(markdown("Edit [the reader](/repo/src/reader.ts) and `src/writer.ts:12` today")).toEqual(
      ["Edit reader.ts and writer.ts · L12 today"],
    );
  });

  it("reads a pull request link as its chip", () => {
    expect(markdown("Merged [Fix the flake](https://github.com/acme/app/pull/12)")).toEqual([
      "Merged #12Fix the flake",
    ]);
  });

  it("has nothing to find in a remote image", () => {
    expect(markdown("![a diagram of the flow](https://example.com/flow.png)")).toEqual([]);
  });

  it("reads a skill by its display name", () => {
    expect(
      markdown("Run $review-pr next", {
        skills: [{ name: "review-pr", displayName: "Review PR" }],
      }),
    ).toEqual(["Run Review PR next"]);
  });

  it("reads each top-level block alone, as the renderer parses it", () => {
    // splitMarkdownBlocks parses blocks one at a time: a reference whose
    // definition sits in another block stays literal on screen, and the
    // definition itself draws nothing.
    expect(markdown("See [docs][1]\n\n[1]: https://example.com")).toEqual(["See [docs][1]"]);
  });
});

describe("markdownFirstLine", () => {
  it("reads the first line shown as words, chips spaced from their neighbours", () => {
    const firstLine = (text: string) => markdownFirstLine({ text, cwd: "/repo", skills: [] });
    expect(
      firstLine(
        "The **fix** is in, see [the pull request](https://github.com/o/r/pull/1).\n\nMore below.",
      ),
    ).toBe("The fix is in, see #1 the pull request.");
    expect(firstLine("See [the pull\nrequest](https://github.com/o/r/pull/1) today.")).toBe(
      "See #1 the pull request today.",
    );
    expect(firstLine("Changed [ChatView.tsx](/repo/src/ChatView.tsx): the\nheader")).toBe(
      "Changed ChatView.tsx: the header",
    );
    // Only up to where the block draws a new line: a line break, a line of code.
    expect(firstLine("First line  \nsecond line")).toBe("First line");
    expect(firstLine("```sh\n\ngit log --oneline -3\ngit status\n```")).toBe(
      "git log --oneline -3",
    );
    // A block with nothing to read (a remote picture, a diagram) gives way to the next.
    expect(firstLine("![chart](https://example.com/c.png)\n\n## Summary\n\n- one")).toBe("Summary");
    expect(firstLine("```mermaid\ngraph TD\n  A --> B\n```")).toBe("");
    expect(firstLine("   ")).toBe("");
  });
});

describe("findableUserMessageBlocks", () => {
  it("reads a sent message without its terminal-context chips", () => {
    expect(
      findableUserMessageBlocks({
        text: "Look at @terminal-1:3-5 and fix it",
        terminalContexts: [{ header: "Terminal 1 lines 3-5" }],
        skills: [],
      }),
    ).toEqual(["Look at  and fix it"]);
  });

  it("reads skills by their display name", () => {
    expect(
      findableUserMessageBlocks({
        text: "$review-pr please",
        terminalContexts: [],
        skills: [{ name: "review-pr", displayName: "Review PR" }],
      }),
    ).toEqual(["Review PR please"]);
  });
});
