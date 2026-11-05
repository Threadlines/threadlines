import { describe, expect, it } from "vite-plus/test";

import { linkSource, withoutLinkSource } from "./linkSource";

describe("linkSource", () => {
  it("reads our ref tag first, then a utm_source tag", () => {
    expect(linkSource(new URL("https://www.threadlines.dev/download?ref=X"))).toBe("x");
    expect(linkSource(new URL("https://www.threadlines.dev/?utm_source=newsletter"))).toBe(
      "newsletter",
    );
    expect(linkSource(new URL("https://www.threadlines.dev/?ref=readme&utm_source=x"))).toBe(
      "readme",
    );
    expect(linkSource(new URL("https://www.threadlines.dev/?ref=%20"))).toBeNull();
  });

  it("drops source tags and keeps everything else", () => {
    const url = new URL(
      "https://www.threadlines.dev/compare?ref=x&utm_source=a&utm_medium=b&tab=2#faq",
    );
    expect(withoutLinkSource(url).href).toBe("https://www.threadlines.dev/compare?tab=2#faq");
  });
});
