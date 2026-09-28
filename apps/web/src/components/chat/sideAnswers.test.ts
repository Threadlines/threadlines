import {
  EventId,
  MessageId,
  type OrchestrationThreadActivity,
  SIDE_ANSWER_OUTCOME_ACTIVITY_KIND,
  SideTurnId,
  ThreadParticipantId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { deriveMessagesTimelineRows, type MessagesTimelineRow } from "./MessagesTimeline.logic";
import { deriveSideAnswers, sideExchangeRows, type SideAnswerView } from "./sideAnswers";

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

  it("keeps an agent's review tagged after it settles, read from its request message", () => {
    const sideTurnId = SideTurnId.make("side-review");
    const request: ChatMessage = {
      ...question(sideTurnId, "2026-01-01T00:00:01Z"),
      fromAgent: { participantId: null },
      requestKind: "review",
      reviewInput: {
        basis: {
          kind: "uncommitted",
          files: 2,
          truncated: true,
          capturedAt: "2026-01-01T00:00:01Z",
        },
        diff: "diff --git a/lock.ts b/lock.ts",
      },
    };
    // Settled: the side turn is gone, only the messages remain.
    const [view] = deriveSideAnswers({
      messages: [request, answer(sideTurnId, "2026-01-01T00:00:05Z")],
      activities: [],
      sideTurn: null,
    });
    expect(view).toMatchObject({
      kind: "review",
      askedBy: { participantId: null },
      state: "answered",
    });
    const answerRow = sideExchangeRows({
      view: view!,
      askedAtMs: 0,
      publishedAtMs: null,
      compact: false,
      expanded: false,
    }).asked.find((row) => row.id === view!.answer?.id);
    expect(answerRow).toMatchObject({ kind: "message", sideReview: request });
  });
});

describe("side exchanges in the timeline", () => {
  const at = (seconds: number) => `2026-01-01T00:00:${String(seconds).padStart(2, "0")}Z`;
  const userEntry = {
    id: "user-entry",
    kind: "message" as const,
    createdAt: at(0),
    message: {
      id: MessageId.make("user"),
      role: "user" as const,
      text: "Fix the lock, then have Astra look at it.",
      createdAt: at(0),
      streaming: false,
    },
  };
  const step = (id: string, seconds: number) => ({
    id,
    kind: "work" as const,
    createdAt: at(seconds),
    entry: {
      id,
      createdAt: at(seconds),
      label: "Read file",
      tone: "tool" as const,
      itemType: "dynamic_tool_call" as const,
      toolTitle: "Read file",
      detail: "src/lock.ts",
      turnId: "turn-1" as never,
    } satisfies WorkLogEntry,
  });
  const sideTurnId = SideTurnId.make("side-1");
  const exchange = (
    overrides: Partial<SideAnswerView> & { readonly answeredAt?: number },
  ): SideAnswerView => {
    const { answeredAt, ...rest } = overrides;
    return {
      sideTurnId,
      participantId: astra,
      kind: "ask",
      askedBy: null,
      question: question(sideTurnId, at(5)),
      answer:
        answeredAt === undefined
          ? null
          : { ...answer(sideTurnId, at(answeredAt - 1)), completedAt: at(answeredAt) },
      steps: [],
      state: answeredAt === undefined ? "answering" : "answered",
      error: null,
      ...rest,
    };
  };
  const derive = (
    entries: Parameters<typeof deriveMessagesTimelineRows>[0]["timelineEntries"],
    sideAnswers: ReadonlyArray<SideAnswerView>,
    options: { readonly working?: boolean; readonly expanded?: boolean } = {},
  ) =>
    deriveMessagesTimelineRows({
      timelineEntries: entries,
      isWorking: options.working ?? true,
      activeTurnInProgress: options.working ?? true,
      activeTurnId: "turn-1" as never,
      activeTurnStartedAt: at(0),
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
      sideAnswers,
      expandedSideTurnIds: new Set(options.expanded ? [sideTurnId] : []),
    });
  const layout = (rows: ReadonlyArray<MessagesTimelineRow>) =>
    rows.map((row) =>
      row.kind === "side-status"
        ? `${row.id} ${row.state}${row.compact ? " compact" : ""}`
        : row.id,
    );
  const trays = (rows: ReadonlyArray<MessagesTimelineRow>) => rows.map((row) => row.tray);

  it("puts an agent's review right after the step that asked, and its later work below", () => {
    const rows = derive(
      [userEntry, step("read", 2), step("review-call", 4), step("edit", 10)],
      [exchange({ askedBy: { participantId: null }, answeredAt: 8 })],
    );
    // The agent waited for the review, so it reads as one block.
    expect(layout(rows)).toEqual([
      "user-entry",
      "read",
      "question-side-1",
      "side-answer:side-1",
      "edit",
      "working-indicator-row",
    ]);
    // It closes the agent's tray; the work after it opens a new one.
    expect(trays(rows)).toEqual([null, "single", null, null, "first", "last"]);
  });

  it("answers a side question on one line while the agent works, then posts the answer below", () => {
    const entries = [userEntry, step("read", 2), step("edit", 10)];
    const live = derive(entries, [exchange({})]);
    expect(layout(live)).toEqual([
      "user-entry",
      "read",
      "question-side-1",
      "side-status:side-1 answering compact",
      "edit",
      "working-indicator-row",
    ]);
    // Opened, the line shows the answer being written right under it.
    const streaming = { ...answer(sideTurnId, at(9)), streaming: true };
    expect(layout(derive(entries, [exchange({ answer: streaming })], { expanded: true }))).toEqual([
      "user-entry",
      "read",
      "question-side-1",
      "side-status:side-1 answering compact",
      "side-answer:side-1",
      "edit",
      "working-indicator-row",
    ]);

    // Done after the agent went on: the line stays, and the answer is posted
    // where the chat had got to, linked to its question.
    const done = derive([...entries, step("test", 14)], [exchange({ answeredAt: 12 })]);
    expect(layout(done)).toEqual([
      "user-entry",
      "read",
      "question-side-1",
      "side-status:side-1 answered-below",
      "edit",
      "side-answer:side-1",
      "test",
      "working-indicator-row",
    ]);
    expect(done.find((row) => row.id === "side-answer:side-1")).toMatchObject({
      sideReplyTo: { id: "question-side-1" },
    });
  });

  it("keeps a side question on its one line even once the agent at work stops", () => {
    // Whether an agent is working can change while the answer is written;
    // the line must not open by itself when it does.
    const rows = derive([userEntry, step("read", 2)], [exchange({})], { working: false });
    expect(layout(rows)).toEqual([
      "user-entry",
      "read",
      "question-side-1",
      "side-status:side-1 answering compact",
    ]);
  });

  it("keeps an answer the reader watched under its question when it is done", () => {
    const rows = derive(
      [userEntry, step("read", 2), step("edit", 10), step("test", 14)],
      [exchange({ answeredAt: 12 })],
      { expanded: true },
    );
    expect(layout(rows)).toEqual([
      "user-entry",
      "read",
      "question-side-1",
      "side-status:side-1 answered compact",
      "side-answer:side-1",
      // The agent's later steps, one group below it.
      "edit",
      "working-indicator-row",
    ]);
  });

  it("lays out an answered side question the same way whatever else was said meanwhile", () => {
    // Nothing between the question and its answer: the answer still follows
    // the question's line, so steps that show up later cannot re-lay it out.
    const rows = derive(
      [userEntry, step("read", 2), step("edit", 10)],
      [exchange({ answeredAt: 8 })],
    );
    expect(layout(rows)).toEqual([
      "user-entry",
      "read",
      "question-side-1",
      "side-status:side-1 answered-below",
      "side-answer:side-1",
      "edit",
      "working-indicator-row",
    ]);
  });

  it("stays below the answer it followed when the turn settles and lifts its last steps", () => {
    const response = {
      id: "response-entry",
      kind: "message" as const,
      createdAt: at(10),
      message: {
        id: MessageId.make("response"),
        role: "assistant" as const,
        text: "Fixed the lock.",
        turnId: "turn-1" as never,
        createdAt: at(10),
        completedAt: at(11),
        streaming: false,
      },
    };
    // A step recorded after the answer; a settled turn shows it above it.
    const rows = derive(
      [userEntry, response, step("checkpoint", 21)],
      [exchange({ answeredAt: 13, question: question(sideTurnId, at(12)) })],
      {
        working: false,
      },
    );
    expect(layout(rows)).toEqual([
      "user-entry",
      "checkpoint",
      "response-entry",
      "question-side-1",
      "side-status:side-1 answered-below",
      "side-answer:side-1",
    ]);
  });
});
