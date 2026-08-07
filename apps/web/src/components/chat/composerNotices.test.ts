import { describe, expect, it } from "vite-plus/test";

import { type ComposerNotice, selectComposerNotices } from "./composerNotices";

function notice(id: string, severity: ComposerNotice["severity"]): ComposerNotice {
  return { id, lead: id, severity };
}

describe("selectComposerNotices", () => {
  it("drops absent entries and keeps a single notice as-is", () => {
    expect(selectComposerNotices([null, notice("thread-error", "error"), undefined])).toEqual([
      notice("thread-error", "error"),
    ]);
  });

  it("puts the worst severity first so the dock always shows it", () => {
    const selected = selectComposerNotices([
      notice("startup", "warning"),
      notice("thread-error", "error"),
    ]);

    expect(selected.map((entry) => entry.id)).toEqual(["thread-error", "startup"]);
  });

  it("keeps caller order between same-severity notices", () => {
    const selected = selectComposerNotices([
      notice("preflight", "warning"),
      notice("provider-status", "warning"),
    ]);

    expect(selected.map((entry) => entry.id)).toEqual(["preflight", "provider-status"]);
  });

  it("holds back informational notices while something is actually wrong", () => {
    const selected = selectComposerNotices([
      notice("version-mismatch", "info"),
      notice("provider-status", "warning"),
    ]);

    expect(selected.map((entry) => entry.id)).toEqual(["provider-status"]);
  });

  it("shows informational notices once the urgent ones clear", () => {
    const selected = selectComposerNotices([notice("version-mismatch", "info")]);

    expect(selected.map((entry) => entry.id)).toEqual(["version-mismatch"]);
  });
});
