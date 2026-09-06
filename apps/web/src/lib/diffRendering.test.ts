import { describe, expect, it } from "vite-plus/test";
import { buildFileDiffRenderKey, buildPatchCacheKey, getRenderablePatch } from "./diffRendering";

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

describe("getRenderablePatch identity across refetches", () => {
  const fileA = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    " const a = 1;",
    "-export const b = 2;",
    "+export const b = 3;",
  ].join("\n");
  const fileB = (value: string) =>
    [
      "diff --git a/src/b.ts b/src/b.ts",
      `index 3333333..${value.length}444444 100644`,
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-export const c = 0;",
      `+export const c = ${value};`,
    ].join("\n");

  it("keeps the object for a file whose change did not move", () => {
    const scope = `identity-test:${Math.random()}`;
    const first = getRenderablePatch(`${fileA}\n${fileB("1")}`, scope);
    const second = getRenderablePatch(`${fileA}\n${fileB("2")}`, scope);
    if (first?.kind !== "files" || second?.kind !== "files") {
      throw new Error("expected structured files");
    }

    expect(second.files[0]).toBe(first.files[0]);
    expect(second.files[1]).not.toBe(first.files[1]);
    expect(second.files[1]?.additionLines).toContain("export const c = 2;");
  });

  it("keys a file by its path, not by the parse it came from", () => {
    const scope = `identity-test:${Math.random()}`;
    const first = getRenderablePatch(`${fileA}\n${fileB("1")}`, scope);
    const second = getRenderablePatch(`${fileA}\n${fileB("2")}`, scope);
    if (first?.kind !== "files" || second?.kind !== "files") {
      throw new Error("expected structured files");
    }

    expect(second.files.map(buildFileDiffRenderKey)).toEqual(
      first.files.map(buildFileDiffRenderKey),
    );
    expect(second.files[1]?.cacheKey).not.toBe(first.files[1]?.cacheKey);
  });
});
