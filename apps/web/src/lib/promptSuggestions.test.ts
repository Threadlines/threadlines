import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EventId,
  type OrchestrationThreadActivity,
  ProviderDriverKind,
  ThreadParticipantId,
  TurnId,
} from "@threadlines/contracts";

import {
  deriveLatestPromptSuggestion,
  type PromptSuggestionSelectionInput,
  PROMPT_SUGGESTION_SWEEP,
  resolvePromptSuggestionView,
  selectPromptSuggestion,
  startPromptSuggestionSweeps,
} from "./promptSuggestions";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");

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
          suggestion: "run the test suite.",
        }),
      ])?.text,
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
      )?.text,
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
      recipientDriverKind: CLAUDE,
      phase: "ready",
      sideAnswerInProgress: false,
      isSendBusy: false,
      hasComposerApproval: false,
      pendingUserInputCount: 0,
      showPlanFollowUpPrompt: false,
      queuedMessageCount: 0,
      latestTurn: { turnId: TurnId.make("turn-1"), state: "completed" },
      dismissedTurnId: null,
      activities: [
        makeActivity("activity-1", "prompt-suggestion.updated", { suggestion: "Add tests." }),
      ],
      ...overrides,
    };
  }

  it("surfaces the suggestion for a completed turn on an idle, empty composer", () => {
    expect(selectPromptSuggestion(makeInput())).toEqual({
      id: "activity-1",
      text: "Add tests.",
    });
  });

  it("shows a suggestion only while the next message goes to the kind of agent that made it", () => {
    // Recorded before the provider was stamped: only Claude made those.
    expect(selectPromptSuggestion(makeInput({ recipientDriverKind: CODEX }))).toBeNull();

    const fromCodex = [
      makeActivity("activity-codex", "prompt-suggestion.updated", {
        suggestion: "Ship it.",
        provider: "codex",
      }),
    ];
    expect(
      selectPromptSuggestion(makeInput({ activities: fromCodex, recipientDriverKind: CODEX }))
        ?.text,
    ).toBe("Ship it.");
    expect(
      selectPromptSuggestion(makeInput({ activities: fromCodex, recipientDriverKind: CLAUDE })),
    ).toBeNull();
  });

  it("in a room, shows only the suggestion of the agent the next message goes to", () => {
    const activities = [
      makeActivity("activity-own", "prompt-suggestion.updated", { suggestion: "Add tests." }),
      {
        ...makeActivity("activity-other", "prompt-suggestion.updated", {
          suggestion: "Make a PR.",
        }),
        participantId: ThreadParticipantId.make("agent-2"),
      },
    ];
    const fromAgent = (participantId: string | null) => (activity: OrchestrationThreadActivity) =>
      (activity.participantId ?? null) === participantId;

    expect(
      selectPromptSuggestion(makeInput({ activities, isFromRecipient: fromAgent("agent-2") }))
        ?.text,
    ).toBe("Make a PR.");
    expect(
      selectPromptSuggestion(makeInput({ activities, isFromRecipient: fromAgent(null) }))?.text,
    ).toBe("Add tests.");
    expect(
      selectPromptSuggestion(makeInput({ activities, isFromRecipient: fromAgent("agent-3") })),
    ).toBeNull();
  });

  it.each([
    ["running phase", { phase: "running" } as const],
    ["a side answer in a room", { sideAnswerInProgress: true }],
    ["send in flight", { isSendBusy: true }],
    ["pending approval", { hasComposerApproval: true }],
    ["pending user input", { pendingUserInputCount: 1 }],
    ["plan follow-up", { showPlanFollowUpPrompt: true }],
    ["queued messages", { queuedMessageCount: 1 }],
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
      )?.text,
    ).toBe("Ship it.");
  });
});

describe("resolvePromptSuggestionView", () => {
  const suggestion = "Add a test for midnight";
  const view = (prompt: string, cursor = prompt.length) =>
    resolvePromptSuggestionView({ prompt, cursor, suggestion });

  it("takes the hint's place in an empty box", () => {
    expect(view("")).toEqual({ kind: "placeholder" });
  });

  it("keeps the rest after the cursor while the typed text starts it, ignoring case", () => {
    expect(view("add a te")).toEqual({ kind: "completion", remainder: "st for midnight" });
    expect(view("Add a test ")).toEqual({ kind: "completion", remainder: "for midnight" });
  });

  it("goes away once the typed text leaves it, fills it, or the cursor moves back", () => {
    expect(view("Add a toast")).toBeNull();
    expect(view("Add a test for midnight")).toBeNull();
    expect(view("Add a te", 3)).toBeNull();
    expect(view("   ")).toBeNull();
  });

  it("never completes text the editor draws as chips or commands", () => {
    const resolve = (prompt: string, text: string) =>
      resolvePromptSuggestionView({ prompt, cursor: prompt.length, suggestion: text });
    expect(resolve("Look at @src", "Look at @src/app.ts")).toBeNull();
    expect(resolve("Use $rev", "Use $review on it")).toBeNull();
    expect(resolve("/comp", "/compact the thread")).toBeNull();
    expect(resolve("First\nsec", "First\nsecond line")).toBeNull();
  });
});

describe("startPromptSuggestionSweeps", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweeps as the suggestion arrives, a few more times, then stops for good", () => {
    vi.useFakeTimers();
    const { durationMs, everyMs, times } = PROMPT_SUGGESTION_SWEEP;
    const starts: number[] = [];
    let sweeping = false;
    startPromptSuggestionSweeps((next) => {
      sweeping = next;
      if (next) starts.push(Date.now());
    });
    const arrivedAt = Date.now();

    // On right away, off once the sweep's CSS has run, still until the next.
    expect(sweeping).toBe(true);
    vi.advanceTimersByTime(durationMs);
    expect(sweeping).toBe(false);
    vi.advanceTimersByTime(everyMs - durationMs - 1);
    expect(sweeping).toBe(false);

    vi.advanceTimersByTime(everyMs * times * 2);
    expect(starts.map((at) => at - arrivedAt)).toEqual(
      Array.from({ length: times }, (_, index) => index * everyMs),
    );
    expect(sweeping).toBe(false);
    // Nothing left running: a suggestion that sits there never animates again.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops early when the suggestion goes away", () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const stop = startPromptSuggestionSweeps((next) => changes.push(next));
    stop();
    vi.advanceTimersByTime(PROMPT_SUGGESTION_SWEEP.everyMs * PROMPT_SUGGESTION_SWEEP.times);
    expect(changes).toEqual([true]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
