import { describe, expect, it } from "vitest";

import { formatCommitGraphTimestamp } from "./SourceControlPanel.logic";

describe("SourceControlPanel.logic", () => {
  it("formats recent commit timestamps", () => {
    expect(
      formatCommitGraphTimestamp("2026-05-25T12:00:00.000Z", new Date("2026-05-25T13:30:00.000Z")),
    ).toBe("1h ago");
  });
});
