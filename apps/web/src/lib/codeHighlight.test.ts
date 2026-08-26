import { describe, expect, it } from "vite-plus/test";

import { applyStreamTokens, type StreamToken } from "./codeHighlight";

const token = (content: string): StreamToken => ({ content, color: "#fff", fontStyle: 0 });

describe("applyStreamTokens", () => {
  it("appends when the tokenizer recalls nothing", () => {
    const previous = [token("const"), token(" a")];
    expect(applyStreamTokens(previous, { recall: 0, tokens: [token(" ="), token(" 1")] })).toEqual([
      token("const"),
      token(" a"),
      token(" ="),
      token(" 1"),
    ]);
  });

  it("replaces the recalled tail before appending", () => {
    const previous = [token("const"), token(" a"), token(" =")];
    // The last line was re-tokenized: its two trailing tokens come back changed.
    expect(
      applyStreamTokens(previous, { recall: 2, tokens: [token(" ab"), token(" ==")] }),
    ).toEqual([token("const"), token(" ab"), token(" ==")]);
  });

  it("drops everything when the recall is larger than what is held", () => {
    const previous = [token("a"), token("b")];
    expect(applyStreamTokens(previous, { recall: 5, tokens: [token("c")] })).toEqual([token("c")]);
  });
});
