import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@threadlines/contracts";

import {
  deriveLatestPromptSuggestion,
  type PromptSuggestionSelectionInput,
  selectPromptSuggestion,
} from "./promptSuggestions";

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

describe("selectPromptSuggestion", () => {
  function makeInput(
    overrides?: Partial<PromptSuggestionSelectionInput>,
  ): PromptSuggestionSelectionInput {
    return {
      isSuggestionProvider: true,
      composerIsEmpty: true,
      phase: "ready",
      isSendBusy: false,
      hasComposerApproval: false,
      pendingUserInputCount: 0,
      showPlanFollowUpPrompt: false,
      latestTurn: { turnId: TurnId.make("turn-1"), state: "completed" },
      dismissedTurnId: null,
      activities: [
        makeActivity("activity-1", "prompt-suggestion.updated", { suggestion: "Add tests." }),
      ],
      ...overrides,
    };
  }

  it("surfaces the suggestion for a completed turn on an idle, empty composer", () => {
    expect(selectPromptSuggestion(makeInput())).toBe("Add tests.");
  });

  it("hides the suggestion for other providers", () => {
    expect(selectPromptSuggestion(makeInput({ isSuggestionProvider: false }))).toBeNull();
  });

  it("hides the suggestion while the composer has text", () => {
    expect(selectPromptSuggestion(makeInput({ composerIsEmpty: false }))).toBeNull();
  });

  it.each([
    ["running phase", { phase: "running" } as const],
    ["send in flight", { isSendBusy: true }],
    ["pending approval", { hasComposerApproval: true }],
    ["pending user input", { pendingUserInputCount: 1 }],
    ["plan follow-up", { showPlanFollowUpPrompt: true }],
  ])("hides the suggestion during %s", (_label, overrides) => {
    expect(selectPromptSuggestion(makeInput(overrides))).toBeNull();
  });

  it("hides the suggestion until the latest turn has completed", () => {
    expect(
      selectPromptSuggestion(
        makeInput({ latestTurn: { turnId: TurnId.make("turn-1"), state: "running" } }),
      ),
    ).toBeNull();
  });

  it("hides the suggestion the user already responded to, even once the composer empties", () => {
    // Reproduces the post-submit flash: composer is empty again and the dispatch
    // has been acknowledged (isSendBusy false), but the next turn has not yet
    // registered so the latest turn is still the dismissed completed one.
    expect(
      selectPromptSuggestion(makeInput({ dismissedTurnId: TurnId.make("turn-1") })),
    ).toBeNull();
  });

  it("surfaces a fresh suggestion once a newer turn completes", () => {
    expect(
      selectPromptSuggestion(
        makeInput({
          latestTurn: { turnId: TurnId.make("turn-2"), state: "completed" },
          dismissedTurnId: TurnId.make("turn-1"),
          activities: [
            makeActivity(
              "activity-2",
              "prompt-suggestion.updated",
              { suggestion: "Ship it." },
              "turn-2",
            ),
          ],
        }),
      ),
    ).toBe("Ship it.");
  });
});
