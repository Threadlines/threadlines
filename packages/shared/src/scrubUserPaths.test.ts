import { assert, describe, it } from "vitest";

import { restoreUserPaths, scrubUserPaths } from "./scrubUserPaths.ts";

describe("scrubUserPaths", () => {
  it("replaces the home folder wherever it stands alone as a path", () => {
    assert.equal(scrubUserPaths("at /home/a/cache", "/home/a"), "at ~/cache");
    assert.equal(scrubUserPaths('"/home/a"', "/home/a"), '"~"');
    assert.equal(scrubUserPaths("file:///home/a/x", "/home/a"), "file://~/x");
    assert.equal(scrubUserPaths("C:/Users/Will/x", "C:\\Users\\will"), "~/x");
  });

  it("leaves other paths, branches and addresses that only contain it", () => {
    for (const [text, home] of [
      ["/home/alice/work", "/home/a"],
      ["https://example.test/home/a/docs", "/home/a"],
      ["fix/root-parser", "/root"],
      ["/var/root/x", "/root"],
    ] as const) {
      assert.equal(scrubUserPaths(text, home), text);
    }
  });

  it("gets back an option an assistant was shown scrubbed", () => {
    const shown = scrubUserPaths("/home/a/cache", "/home/a");
    assert.equal(restoreUserPaths(shown, "/home/a"), "/home/a/cache");
    assert.equal(restoreUserPaths("costs ~5 or a~/b", "/home/a"), "costs ~5 or a~/b");
  });
});
