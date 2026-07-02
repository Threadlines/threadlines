import { describe, expect, it } from "vitest";

import {
  appendFileSelectionContextsToPrompt,
  appendFileSelectionToPrompt,
  fileSelectionContextDedupKey,
  formatFileSelectionContextBlock,
  formatFileSelectionContextLabel,
  formatFileSelectionLineRange,
  inferFenceLanguage,
  sliceFileSelection,
} from "./fileSelectionContext";

describe("inferFenceLanguage", () => {
  it("maps known extensions to fence languages", () => {
    expect(inferFenceLanguage("src/components/App.tsx")).toBe("tsx");
    expect(inferFenceLanguage("scripts/build.sh")).toBe("bash");
    expect(inferFenceLanguage("config.yml")).toBe("yaml");
  });

  it("returns an empty language for unknown or missing extensions", () => {
    expect(inferFenceLanguage("Makefile")).toBe("");
    expect(inferFenceLanguage("assets/logo.abc")).toBe("");
  });
});

describe("formatFileSelectionLineRange", () => {
  it("collapses single-line selections", () => {
    expect(formatFileSelectionLineRange({ startLine: 7, endLine: 7 })).toBe("L7");
  });

  it("formats multi-line selections", () => {
    expect(formatFileSelectionLineRange({ startLine: 3, endLine: 9 })).toBe("L3-L9");
  });
});

describe("formatFileSelectionContextBlock", () => {
  it("wraps the selection in a fenced block headed by the file reference", () => {
    const block = formatFileSelectionContextBlock({
      relativePath: "src/main.ts",
      startLine: 2,
      endLine: 3,
      selectedText: "const a = 1;\nconst b = 2;",
    });

    expect(block).toBe("`src/main.ts:2-3`\n```ts\nconst a = 1;\nconst b = 2;\n```");
  });

  it("widens the fence when the selection contains backtick fences", () => {
    const block = formatFileSelectionContextBlock({
      relativePath: "README.md",
      startLine: 1,
      endLine: 3,
      selectedText: "```js\nconsole.log(1);\n```",
    });

    expect(block.startsWith("`README.md:1-3`\n````markdown\n")).toBe(true);
    expect(block.endsWith("\n````")).toBe(true);
  });
});

describe("appendFileSelectionToPrompt", () => {
  const context = {
    relativePath: "src/main.ts",
    startLine: 1,
    endLine: 1,
    selectedText: "export {};",
  };

  it("appends after existing prompt text with a blank line", () => {
    const next = appendFileSelectionToPrompt("Fix this:", context);
    expect(next).toBe("Fix this:\n\n`src/main.ts:1`\n```ts\nexport {};\n```\n");
  });

  it("stands alone when the prompt is empty", () => {
    const next = appendFileSelectionToPrompt("   ", context);
    expect(next).toBe("`src/main.ts:1`\n```ts\nexport {};\n```\n");
  });
});

describe("whole-file references", () => {
  it("serializes whole-file chips as @path mentions without quoting contents", () => {
    const next = appendFileSelectionContextsToPrompt("Check this", [
      { relativePath: "package.json", startLine: 1, endLine: 1, selectedText: "", wholeFile: true },
    ]);
    expect(next).toBe("Check this\n\n@package.json\n");
    expect(next).not.toContain("```");
  });

  it("labels and dedupes whole-file chips by path", () => {
    const context = {
      relativePath: "apps/web/package.json",
      startLine: 1,
      endLine: 1,
      selectedText: "",
      wholeFile: true as const,
    };
    expect(formatFileSelectionContextLabel(context)).toBe("package.json");
    expect(fileSelectionContextDedupKey(context)).toBe("apps/web/package.json:file");
  });
});

describe("sliceFileSelection", () => {
  const content = "one\ntwo\nthree\nfour";

  it("returns the inclusive 1-based line span", () => {
    expect(sliceFileSelection(content, 2, 3)).toBe("two\nthree");
  });

  it("normalizes reversed ranges and clamps out-of-bounds lines", () => {
    expect(sliceFileSelection(content, 3, 2)).toBe("two\nthree");
    expect(sliceFileSelection(content, 1, 99)).toBe(content);
  });
});
