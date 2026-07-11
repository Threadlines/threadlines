import { describe, expect, it } from "vite-plus/test";

import { serializeComposerMentionPath } from "./composerMentionPath";

describe("serializeComposerMentionPath", () => {
  it("keeps simple mention paths unquoted", () => {
    expect(serializeComposerMentionPath("src/index.ts")).toBe("src/index.ts");
  });

  it("quotes mention paths containing whitespace", () => {
    expect(serializeComposerMentionPath("docs/My File.md")).toBe('"docs/My File.md"');
  });

  it("escapes quoted mention path content", () => {
    expect(serializeComposerMentionPath('docs/My "File".md')).toBe('"docs/My \\"File\\".md"');
  });
});
