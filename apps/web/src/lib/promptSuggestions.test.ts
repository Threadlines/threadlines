import { describe, expect, it } from "vitest";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import { deriveLatestPromptSuggestion } from "./promptSuggestions";

function makeActivity(
  id: string,
  kind: string,
  payload: unknown,
  turnId: string | null = "turn-1",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: turnId === null ? null : TurnId.make(turnId),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("promptSuggestions", () => {
  it("derives the latest prompt suggestion", () => {
    expect(
      deriveLatestPromptSuggestion([
        makeActivity("activity-1", "prompt-suggestion.updated", {
          suggestion: "Add tests.",
        }),
        makeActivity("activity-2", "tool.started", {}),
        makeActivity("activity-3", "prompt-suggestion.updated", {
          suggestion: "Run the test suite.",
        }),
      ]),
    ).toBe("Run the test suite.");
  });

  it("can scope suggestions to the latest turn", () => {
    expect(
      deriveLatestPromptSuggestion(
        [
          makeActivity("activity-1", "prompt-suggestion.updated", {
            suggestion: "Old suggestion.",
          }),
          makeActivity(
            "activity-2",
            "prompt-suggestion.updated",
            {
              suggestion: "New suggestion.",
            },
            "turn-2",
          ),
        ],
        { turnId: TurnId.make("turn-1") },
      ),
    ).toBe("Old suggestion.");
  });

  it("ignores blank or malformed suggestions", () => {
    expect(
      deriveLatestPromptSuggestion([
        makeActivity("activity-1", "prompt-suggestion.updated", {
          suggestion: "   ",
        }),
        makeActivity("activity-2", "prompt-suggestion.updated", {}),
      ]),
    ).toBeNull();
  });
});
