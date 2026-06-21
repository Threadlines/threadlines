import { describe, expect, it } from "vitest";
import { buildPatchCacheKey, getRenderablePatch } from "./diffRendering";

describe("buildPatchCacheKey", () => {
  it("returns a stable cache key for identical content", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch)).toBe(buildPatchCacheKey(patch));
  });

  it("normalizes outer whitespace before hashing", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(`\n${patch}\n`)).toBe(buildPatchCacheKey(patch));
  });

  it("changes when diff content changes", () => {
    const before = "diff --git a/a.ts b/a.ts\n+console.log('hello')";
    const after = "diff --git a/a.ts b/a.ts\n+console.log('hello world')";

    expect(buildPatchCacheKey(before)).not.toBe(buildPatchCacheKey(after));
  });

  it("changes when cache scope changes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch, "diff-panel:light")).not.toBe(
      buildPatchCacheKey(patch, "diff-panel:dark"),
    );
  });
});

describe("getRenderablePatch", () => {
  it("parses ANSI-colored git patches as structured files", () => {
    const patch = [
      "\u001B[1mdiff --git a/a.ts b/a.ts\u001B[m",
      "\u001B[1mindex 1111111..2222222 100644\u001B[m",
      "\u001B[31m--- a/a.ts\u001B[m",
      "\u001B[32m+++ b/a.ts\u001B[m",
      "\u001B[36m@@ -1 +1 @@\u001B[m",
      "\u001B[31m-old\u001B[m",
      "\u001B[32m+new\u001B[m",
    ].join("\n");

    const renderable = getRenderablePatch(patch, "test-colored-patch");

    expect(renderable?.kind).toBe("files");
    if (!renderable || renderable.kind !== "files") {
      throw new Error("Expected ANSI-colored patch to parse as files.");
    }
    expect(renderable.files).toHaveLength(1);
    expect(renderable.files[0]?.name).toBe("a.ts");
    expect(renderable.files[0]?.hunks).toHaveLength(1);
  });

  it("returns a raw fallback for non-diff text", () => {
    const renderable = getRenderablePatch("\u001B[31mnot a patch\u001B[m", "test-raw");

    expect(renderable).toEqual({
      kind: "raw",
      text: "not a patch",
      reason: "Unsupported diff format. Showing raw patch.",
    });
  });
});
