import { describe, expect, it } from "vitest";

import {
  buildGeneratedCommitMessage,
  formatCommitGraphTimestamp,
} from "./SourceControlPanel.logic";

describe("SourceControlPanel.logic", () => {
  it("builds a generated commit message from changed files", () => {
    expect(
      buildGeneratedCommitMessage([
        { path: "apps/web/src/App.tsx", insertions: 4, deletions: 1 },
        { path: "README.md", insertions: 1, deletions: 0 },
      ]),
    ).toBe("Update App.tsx and 1 more");
  });

  it("formats recent commit timestamps", () => {
    expect(
      formatCommitGraphTimestamp("2026-05-25T12:00:00.000Z", new Date("2026-05-25T13:30:00.000Z")),
    ).toBe("1h ago");
  });
});
