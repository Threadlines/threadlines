import { describe, expect, it } from "vitest";

import { formatForkSourceExcerpt, truncate } from "./String.ts";

describe("truncate", () => {
  it("trims surrounding whitespace", () => {
    expect(truncate("   hello world   ")).toBe("hello world");
  });

  it("returns shorter strings unchanged", () => {
    expect(truncate("alpha", 10)).toBe("alpha");
  });

  it("truncates long strings and appends an ellipsis", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcde...");
  });
});

describe("formatForkSourceExcerpt", () => {
  it("summarizes assistant subagent result messages for human display", () => {
    expect(
      formatForkSourceExcerpt(
        [
          "The subagent was named `Heisenberg`.",
          "",
          "ID: `019ef7fb-225c-7a90-9f3d-a6dfdcfb7395`",
          "Output:",
          "```text",
          "Subagent nickname check complete.",
          "```",
        ].join("\n"),
        500,
      ),
    ).toBe("Subagent Heisenberg completed with output: Subagent nickname check complete.");
  });

  it("removes markdown fence syntax from generic excerpts", () => {
    expect(formatForkSourceExcerpt("Result:\n```text\nhello\n```", 500)).toBe("Result: hello");
  });
});
