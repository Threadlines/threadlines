import { describe, expect, it } from "vite-plus/test";

import {
  isPreviewPartition,
  isSharedPreviewPartition,
  LEGACY_PREVIEW_PARTITION,
  previewProfilePartition,
  previewSharedPartition,
} from "./previewPartitions.ts";

describe("previewProfilePartition", () => {
  it("names a project's partition from a hash of its environment and project", () => {
    // sha256('["environment-1","project-1"]'), first 32 hex characters. A changed
    // name would strand every existing profile, so the format is pinned.
    expect(previewProfilePartition("environment-1", "project-1")).toBe(
      "persist:threadlines-preview-b78c3a8c0ba25ae2862fad7c1bba44a9",
    );
  });

  it("gives the same project on another environment its own partition", () => {
    const here = previewProfilePartition("environment-1", "project-1");
    // Ids that only differ in where a line break falls are still two profiles.
    expect(previewProfilePartition("a\nb", "c")).not.toBe(previewProfilePartition("a", "b\nc"));
    expect(previewProfilePartition("environment-2", "project-1")).not.toBe(here);
    expect(previewProfilePartition("environment-1", "project-2")).not.toBe(here);
    expect(isPreviewPartition(here)).toBe(true);
  });
});

describe("previewSharedPartition", () => {
  it("names an environment's shared partition apart from any project's", () => {
    // sha256('["shared","environment-1"]'), first 32 hex characters, pinned for
    // the same reason as a project's.
    const shared = previewSharedPartition("environment-1");
    expect(shared).toBe("persist:threadlines-preview-shared-2d20f3b1e891bfa7ac827e27bfe64df5");
    expect(isSharedPreviewPartition(shared)).toBe(true);
    expect(isSharedPreviewPartition(previewProfilePartition("environment-1", "project-1"))).toBe(
      false,
    );
    expect(previewSharedPartition("environment-2")).not.toBe(shared);
  });
});

describe("isPreviewPartition", () => {
  it("accepts the legacy shared partition, per-project and shared partitions", () => {
    expect(isPreviewPartition(LEGACY_PREVIEW_PARTITION)).toBe(true);
    expect(isPreviewPartition(`persist:threadlines-preview-${"a".repeat(32)}`)).toBe(true);
    expect(isPreviewPartition(`persist:threadlines-preview-shared-${"a".repeat(32)}`)).toBe(true);
  });

  it("refuses every other session", () => {
    for (const partition of [
      undefined,
      null,
      "",
      "persist:threadlines",
      "threadlines-preview",
      // In-memory: would lose the sign-in on every restart.
      `threadlines-preview-${"a".repeat(32)}`,
      `persist:threadlines-preview-${"A".repeat(32)}`,
      `persist:threadlines-preview-${"a".repeat(31)}`,
      `persist:threadlines-preview-${"a".repeat(33)}`,
      `persist:threadlines-preview-${"g".repeat(32)}`,
      `persist:threadlines-preview-${"a".repeat(32)}\n`,
      `persist:threadlines-preview-shared-${"a".repeat(31)}`,
      `threadlines-preview-shared-${"a".repeat(32)}`,
    ]) {
      expect(isPreviewPartition(partition), String(partition)).toBe(false);
    }
  });
});
