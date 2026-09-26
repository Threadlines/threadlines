import {
  EventId,
  MessageId,
  type OrchestrationThreadActivity,
  SIDE_ANSWER_OUTCOME_ACTIVITY_KIND,
  SideTurnId,
  ThreadParticipantId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage } from "../../types";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { deriveSideAnswers, placeSideAnswerRows, type SideAnswerView } from "./sideAnswers";

const astra = ThreadParticipantId.make("agent-astra");

const question = (sideTurnId: SideTurnId, createdAt: string): ChatMessage => ({
  id: MessageId.make(`question-${sideTurnId}`),
  role: "user",
  text: "Is the lock released on every path?",
  participantId: astra,
  sideTurnId,
  createdAt,
  streaming: false,
});

const answer = (sideTurnId: SideTurnId, createdAt: string): ChatMessage => ({
  id: MessageId.make(`side-answer:${sideTurnId}`),
  role: "assistant",
  text: "Yes, except when the write fails.",
  participantId: astra,
  sideTurnId,
  createdAt,
  streaming: false,
});

const outcome = (
  sideTurnId: SideTurnId,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity => ({
  id: EventId.make(`outcome-${sideTurnId}`),
  kind: SIDE_ANSWER_OUTCOME_ACTIVITY_KIND,
  summary: "Side answer ended",
  tone: "info",
  payload,
  turnId: null,
  sideTurnId,
  createdAt: "2026-01-01T00:00:09Z",
});

describe("deriveSideAnswers", () => {
  it("reads each side answer's state from the running side turn and how it ended", () => {
    const sideTurnId = SideTurnId.make("side-1");
    const stateOf = (input: {
      readonly running?: "running" | "cancelling";
      readonly answered?: boolean;
      readonly outcome?: Record<string, unknown>;
    }) =>
      deriveSideAnswers({
        messages: [
          question(sideTurnId, "2026-01-01T00:00:01Z"),
          ...(input.answered ? [answer(sideTurnId, "2026-01-01T00:00:05Z")] : []),
        ],
        activities: input.outcome ? [outcome(sideTurnId, input.outcome)] : [],
        sideTurn: input.running
          ? {
              sideTurnId,
              participantId: astra,
              messageId: MessageId.make(`question-${sideTurnId}`),
              status: input.running,
              startedAt: "2026-01-01T00:00:01Z",
            }
          : null,
      }).map((view) => [view.state, view.error]);

    expect(stateOf({ running: "running", answered: true })).toEqual([["answering", null]]);
    expect(stateOf({ running: "cancelling" })).toEqual([["stopping", null]]);
    expect(stateOf({ answered: true })).toEqual([["answered", null]]);
    expect(stateOf({ outcome: { outcome: "failed", error: "Codex is signed out." } })).toEqual([
      ["failed", "Codex is signed out."],
    ]);
    // Stopped partway: what it said stays, and it still reads as stopped.
    expect(stateOf({ answered: true, outcome: { outcome: "interrupted" } })).toEqual([
      ["stopped", null],
    ]);
    expect(stateOf({ outcome: { outcome: "completed" } })).toEqual([
      ["failed", "it ended without a reply."],
    ]);
  });
});

describe("placeSideAnswerRows", () => {
  const row = (
    id: string,
    createdAt: string | null,
    tray: MessagesTimelineRow["tray"],
  ): MessagesTimelineRow => ({
    kind: "working",
    id,
    createdAt,
    label: "Working",
    thought: null,
    tray,
    padTop: false,
  });
  const sideTurnId = SideTurnId.make("side-1");
  const view: SideAnswerView = {
    sideTurnId,
    participantId: astra,
    question: question(sideTurnId, "2026-01-01T00:00:05Z"),
    answer: answer(sideTurnId, "2026-01-01T00:00:08Z"),
    steps: [],
    state: "answered",
    error: null,
  };
  const ids = (rows: ReadonlyArray<MessagesTimelineRow>) => rows.map((entry) => entry.id);

  it("keeps a live tray whole: a question asked mid-turn lands after it", () => {
    const live = [
      row("user", "2026-01-01T00:00:00Z", null),
      row("note", "2026-01-01T00:00:02Z", "first"),
      row("steps", "2026-01-01T00:00:06Z", "middle"),
      // The working row carries the turn's start time.
      row("working", "2026-01-01T00:00:00Z", "last"),
    ];
    expect(ids(placeSideAnswerRows(live, [view]))).toEqual([
      "user",
      "note",
      "steps",
      "working",
      view.question.id,
      view.answer!.id,
    ]);
  });

  it("sits where it was asked once the turn has ended, before the later answer", () => {
    const settled = [
      row("user", "2026-01-01T00:00:00Z", null),
      row("note", "2026-01-01T00:00:02Z", "first"),
      row("steps", "2026-01-01T00:00:06Z", "last"),
      row("answer", "2026-01-01T00:00:20Z", null),
      row("next-user", "2026-01-01T00:00:30Z", null),
    ];
    expect(ids(placeSideAnswerRows(settled, [view]))).toEqual([
      "user",
      "note",
      "steps",
      view.question.id,
      view.answer!.id,
      "answer",
      "next-user",
    ]);
  });
});
