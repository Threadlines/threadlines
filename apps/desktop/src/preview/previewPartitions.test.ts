import { describe, expect, it } from "vite-plus/test";

import {
  isPreviewPartition,
  LEGACY_PREVIEW_PARTITION,
  previewProfilePartition,
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

describe("isPreviewPartition", () => {
  it("accepts the legacy shared partition and per-project partitions", () => {
    expect(isPreviewPartition(LEGACY_PREVIEW_PARTITION)).toBe(true);
    expect(isPreviewPartition(`persist:threadlines-preview-${"a".repeat(32)}`)).toBe(true);
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
    ]) {
      expect(isPreviewPartition(partition), String(partition)).toBe(false);
    }
  });
});
