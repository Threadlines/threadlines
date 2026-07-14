import { describe, expect, it } from "vite-plus/test";
import { canSearchThreadContent } from "./threadSearchReactQuery";

describe("canSearchThreadContent", () => {
  it("requires at least one trigram-searchable token", () => {
    expect(canSearchThreadContent("navbar")).toBe(true);
    expect(canSearchThreadContent("UI navbar")).toBe(true);
    expect(canSearchThreadContent(`"UI x"`)).toBe(true);
    expect(canSearchThreadContent(`"UI"`)).toBe(false);
    expect(canSearchThreadContent("UI x")).toBe(false);
    expect(canSearchThreadContent("  ")).toBe(false);
  });
});
