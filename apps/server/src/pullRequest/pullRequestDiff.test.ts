import { assert, describe, it } from "@effect/vitest";

import { capPullRequestDiff } from "./pullRequestDiff.ts";

describe("capPullRequestDiff", () => {
  const fileBlock = (path: string, padding: number) =>
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -0,0 +1,1 @@",
      `+${"x".repeat(padding)}`,
      "",
    ].join("\n");

  it("leaves a patch under the cap alone", () => {
    const patch = `${fileBlock("a.ts", 10)}${fileBlock("b.ts", 10)}`;

    assert.deepStrictEqual(capPullRequestDiff({ patch, truncated: false }), {
      patch,
      truncated: false,
    });
  });

  it("cuts an over-cap patch at the last whole file", () => {
    const patch = `${fileBlock("a.ts", 40)}${fileBlock("b.ts", 40)}${fileBlock("c.ts", 40)}`;
    const maxBytes = fileBlock("a.ts", 40).length + fileBlock("b.ts", 40).length + 10;

    const result = capPullRequestDiff({ patch, truncated: false, maxBytes });

    assert.equal(result.truncated, true);
    assert.equal(result.patch, `${fileBlock("a.ts", 40)}${fileBlock("b.ts", 40)}`);
  });

  it("drops the half-read file when the process runner truncated the patch", () => {
    const patch = `${fileBlock("a.ts", 20)}diff --git a/b.ts b/b.ts\n--- a/b.ts\n`;

    const result = capPullRequestDiff({ patch, truncated: true });

    assert.equal(result.truncated, true);
    assert.equal(result.patch, fileBlock("a.ts", 20));
  });

  it("cuts a single over-cap file at its last whole line", () => {
    const patch = `${fileBlock("a.ts", 400)}`;

    const result = capPullRequestDiff({ patch, truncated: false, maxBytes: 60 });

    assert.equal(result.truncated, true);
    assert.ok(result.patch.length <= 60);
    assert.ok(result.patch.endsWith("\n"));
  });
});
