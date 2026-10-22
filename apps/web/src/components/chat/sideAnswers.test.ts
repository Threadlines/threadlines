import {
  EventId,
  MessageId,
  type OrchestrationAgentRequest,
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
    options: {
      readonly working?: boolean;
      readonly expanded?: boolean;
      /** The agent at work (default: the thread's own). */
      readonly agent?: ThreadParticipantId;
      readonly roomAgentNames?: ReadonlyMap<string, string>;
      readonly openAgentRequests?: ReadonlyArray<OrchestrationAgentRequest>;
    } = {},
  ) =>
    deriveMessagesTimelineRows({
      roomAgentNames: options.roomAgentNames,
      openAgentRequestByMessageId: new Map(
        (options.openAgentRequests ?? []).map((request) => [request.requestMessageId, request]),
      ),
      timelineEntries: entries,
      isWorking: options.working ?? true,
      activeTurnInProgress: options.working ?? true,
      activeTurnId: "turn-1" as never,
      activeTurnStartedAt: at(0),
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
      sideAnswers,
      expandedSideTurnIds: new Set(options.expanded ? [sideTurnId] : []),
      workingParticipantId: options.agent ?? null,
    });
  const layout = (rows: ReadonlyArray<MessagesTimelineRow>) =>
    rows.map((row) =>
      row.kind === "side-status"
        ? `${row.id} ${row.state}${row.compact ? " compact" : ""}`
        : row.id,
    );

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

  it("names the step a side answer is on, on the working row or its own line", () => {
    const roomAgentNames = new Map([
      ["primary", "Opus 5.5"],
      [astra, "GPT-6-Astra"],
    ]);
    const call = (kind: "ask" | "review", running = true) => ({
      id: "review-call",
      kind: "work" as const,
      createdAt: at(4),
      entry: {
        id: "review-call",
        createdAt: at(4),
        label: "MCP tool call",
        tone: "tool",
        itemType: "mcp_tool_call",
        detail: `threadlines_room · room_${kind}: agent=GPT-6-Astra request=Check the lock`,
        executionState: running ? "running" : "completed",
        turnId: "turn-1" as never,
      } satisfies WorkLogEntry,
    });
    const reading = { ...step("astra-read", 6).entry, executionState: "running" as const };
    const thinking = {
      id: "astra-think",
      createdAt: at(7),
      label: "Thinking",
      tone: "thinking",
      detail: "The retry path never releases it.",
      executionState: "running",
      redactedThinking: false,
    } satisfies WorkLogEntry;
    const review = (overrides: Parameters<typeof exchange>[0] = {}) =>
      exchange({ askedBy: { participantId: null }, kind: "review", ...overrides });
    /** The working row's words, and the step the answer's own line names
     *  (undefined: it has no line). */
    const live = (
      entries: Parameters<typeof derive>[0],
      sideAnswers: ReadonlyArray<SideAnswerView>,
      options: {
        readonly requests?: ReadonlyArray<OrchestrationAgentRequest>;
        readonly working?: boolean;
      } = {},
    ) => {
      const rows = derive(entries, sideAnswers, {
        roomAgentNames,
        openAgentRequests: options.requests ?? [],
        working: options.working ?? true,
      });
      const working = rows.find((row) => row.kind === "working");
      const line = rows.find((row) => row.kind === "side-status");
      return {
        label: working?.kind === "working" ? working.label : null,
        thought: working?.kind === "working" ? working.thought : null,
        line: line?.kind === "side-status" ? line.liveStep : undefined,
      };
    };

    // The review call has nothing to say while Astra works: Astra's step does,
    // on the working row, so Astra's own line keeps its plain words.
    expect(live([userEntry, call("review")], [review({ steps: [reading] })])).toEqual({
      label: "GPT-6-Astra: Reading lock.ts",
      thought: null,
      line: null,
    });
    expect(live([userEntry, call("review")], [review({ steps: [thinking] })])).toEqual({
      label: "GPT-6-Astra: Thinking",
      thought: "The retry path never releases it.",
      line: null,
    });
    // A thought it keeps to itself, as Codex's arrive, still reads as thinking
    // while it is the newest thing Astra did.
    const privateThought = { ...thinking, redactedThinking: true };
    expect(
      live([userEntry, call("review")], [review({ steps: [reading, privateThought] })]),
    ).toMatchObject({ label: "GPT-6-Astra: Reading lock.ts", thought: null });
    expect(live([userEntry, call("review")], [review({ steps: [privateThought] })])).toEqual({
      label: "GPT-6-Astra: Thinking",
      thought: null,
      line: null,
    });
    expect(
      live(
        [userEntry, call("review")],
        [review({ steps: [privateThought, { ...reading, executionState: "completed" }] })],
      ),
    ).toMatchObject({ label: "GPT-6-Astra is reviewing" });
    expect(live([userEntry, call("ask")], [review({ kind: "ask", state: "stopping" })])).toEqual({
      label: "GPT-6-Astra is stopping",
      thought: null,
      line: null,
    });

    // Nobody waits on it from the working row: its own line names the step.
    // A review whose caller stopped waiting goes on, and a later call is not
    // waiting on it.
    const detached = {
      requestId: "request-1" as never,
      kind: "review",
      from: { participantId: null },
      to: { participantId: astra },
      callerTurnId: "turn-1" as never,
      chainEpoch: 0,
      status: "running",
      requestMessageId: question(sideTurnId, at(5)).id,
      sideTurnId,
      replyAsMessage: true,
      createdAt: at(5),
    } satisfies OrchestrationAgentRequest;
    expect(
      live([userEntry, call("review")], [review({ steps: [reading] })], { requests: [detached] }),
    ).toEqual({ label: "Asking GPT-6-Astra for a review", thought: null, line: "Reading lock.ts" });
    expect(
      live([userEntry, call("review")], [review({ steps: [reading] })], {
        requests: [{ ...detached, replyAsMessage: false }],
      }),
    ).toMatchObject({ label: "GPT-6-Astra: Reading lock.ts", line: null });
    expect(live([userEntry, call("review", false)], [review({ steps: [reading] })])).toEqual({
      label: "Working",
      thought: null,
      line: "Reading lock.ts",
    });
    expect(
      live([userEntry, call("review", false)], [review({ steps: [reading] })], { working: false }),
    ).toEqual({ label: null, thought: null, line: "Reading lock.ts" });
    // The user's own side question is not the one the call waits for.
    expect(live([userEntry, call("review")], [exchange({ steps: [reading] })])).toEqual({
      label: "Asking GPT-6-Astra for a review",
      thought: null,
      line: "Reading lock.ts",
    });
    // Answered: the call's own words until it returns, and no line to name.
    expect(live([userEntry, call("review")], [review({ answeredAt: 8 })])).toEqual({
      label: "Asking GPT-6-Astra for a review",
      thought: null,
      line: undefined,
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

  it("stays where it was asked when a settled turn stands its page at the answer", () => {
    const response = {
      id: "response-entry",
      kind: "message" as const,
      createdAt: at(20),
      message: {
        id: MessageId.make("response"),
        role: "assistant" as const,
        text: "Fixed the lock.",
        turnId: "turn-1" as never,
        createdAt: at(20),
        completedAt: at(21),
        streaming: false,
      },
    };
    const page = {
      id: "page-entry",
      kind: "page" as const,
      createdAt: at(3),
      page: {
        pageId: "page-1" as never,
        versionId: "v1" as never,
        version: 1,
        turnId: "turn-1" as never,
        participantId: null,
        title: "Lock timeline",
        kind: "html" as const,
        height: 400,
        createdAt: at(3),
        updatedAt: at(3),
      },
    };
    // The agent showed a page, was asked a question, and kept working. The
    // page settles at the answer; the exchange keeps its place among the steps.
    const rows = derive(
      [userEntry, step("read", 2), page, step("edit", 10), response],
      [exchange({ answeredAt: 8 })],
      { working: false },
    );
    expect(layout(rows)).toEqual([
      "user-entry",
      "read",
      "question-side-1",
      "side-status:side-1 answered-below",
      "side-answer:side-1",
      "edit",
      "page-entry",
      "response-entry",
    ]);
  });

  describe("on agents' lines", () => {
    const lines = (rows: ReadonlyArray<MessagesTimelineRow>) =>
      rows.map((row) =>
        row.agentLine
          ? [
              row.agentLine.placement,
              row.agentLine.agent ?? "own",
              ...(row.agentLine.heads ? ["named"] : []),
              ...(row.agentLine.nested ? [`nested-${row.agentLine.nested}`] : []),
              ...(row.agentLine.echoesAnswer ? ["echo"] : []),
            ].join(" ")
          : null,
      );

    it("hangs the working agent's stretch on one line through a side exchange, named once", () => {
      const rows = derive(
        [userEntry, step("read", 2), step("review-call", 4), step("edit", 10)],
        [exchange({ askedBy: { participantId: null }, answeredAt: 8 })],
      );
      expect(layout(rows)).toEqual([
        "user-entry",
        "read",
        "question-side-1",
        "side-answer:side-1",
        "edit",
        "working-indicator-row",
      ]);
      // The question stays on the asker's line; the answer is set in under
      // it, named by who answered.
      expect(lines(rows)).toEqual([
        null,
        "start own named",
        "through own",
        "through agent-astra named nested-single",
        "through own",
        "end own",
      ]);
    });

    it("hangs another agent answering inside the stretch on a line of its own", () => {
      const sideStep = { ...step("side-read", 6).entry, turnId: null };
      const streaming = { ...answer(sideTurnId, at(7)), streaming: true };
      // Asked through a room tool: the question says who asked.
      const question = {
        ...exchange({}).question,
        fromAgent: { participantId: null },
        requestKind: "ask" as const,
      };
      const asked = [
        exchange({
          askedBy: { participantId: null },
          question,
          steps: [sideStep],
          answer: streaming,
        }),
      ];
      const entries = [userEntry, step("read", 2), step("ask-call", 4)];
      expect(layout(derive(entries, asked))).toEqual([
        "user-entry",
        "read",
        "question-side-1",
        "side-steps:side-1",
        "side-answer:side-1",
        "side-status:side-1 answering",
        "working-indicator-row",
      ]);
      // Its steps are the stretch it is on for as long as it answers, notes
      // already written or not: they keep landing under the same one answer.
      // They fold once it is done.
      const sideStepsFolded = (views: typeof asked) => {
        const row = derive(entries, views).find((row) => row.id === "side-steps:side-1");
        return row?.kind === "work" ? row.folded : undefined;
      };
      expect(sideStepsFolded(asked)).toBe(false);
      expect(
        sideStepsFolded([
          exchange({
            askedBy: { participantId: null },
            question,
            steps: [sideStep],
            answeredAt: 9,
          }),
        ]),
      ).toBe(true);
      // Set in under the question, from its name down into the line that
      // says it is answering, while the working agent's line runs past.
      expect(lines(derive(entries, asked))).toEqual([
        null,
        "start own named",
        "through own",
        "through agent-astra named nested-start",
        "through agent-astra nested-through",
        "through own nested-end",
        "end own",
      ]);
      // Done, its line bends into its answer instead.
      const answered = [
        exchange({ askedBy: { participantId: null }, question, steps: [sideStep], answeredAt: 8 }),
      ];
      expect(lines(derive(entries, answered)).slice(3)).toEqual([
        "through agent-astra named nested-start",
        "through agent-astra nested-end",
        "end own",
      ]);
    });

    it("starts a line where the speaker changes, and a hand-off's repeated reply is one line", () => {
      const message = (
        id: string,
        seconds: number,
        fields: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text">,
      ) => ({
        id: `${id}-entry`,
        kind: "message" as const,
        createdAt: at(seconds),
        message: {
          id: MessageId.make(id),
          createdAt: at(seconds),
          completedAt: at(seconds),
          streaming: false,
          ...fields,
        },
      });
      const astraStep = { ...step("astra-read", 5) };
      astraStep.entry = { ...astraStep.entry, turnId: "turn-2" as never };
      const reply = "The lock is released on every path now.";
      const rows = derive(
        [
          userEntry,
          step("read", 2),
          message("opus-answer", 3, {
            role: "assistant",
            text: "Fixed the lock.",
            turnId: "turn-1" as never,
          }),
          message("hand-off", 4, {
            role: "user",
            text: "Check every path releases it.",
            participantId: astra,
            fromAgent: { participantId: null },
            requestKind: "hand_off",
            requestOutcome: "answered",
          }),
          astraStep,
          message("astra-answer", 6, {
            role: "assistant",
            text: reply,
            participantId: astra,
            turnId: "turn-2" as never,
          }),
          message("reply", 7, {
            role: "user",
            text: reply,
            fromAgent: { participantId: astra },
            requestKind: "reply",
          }),
        ],
        [],
        { working: false },
      );
      expect(lines(rows)).toEqual([
        null,
        "start own named",
        "end own",
        // A hand-off is its writer speaking.
        "single own named",
        "start agent-astra named",
        "end agent-astra",
        "single agent-astra named echo",
      ]);
    });

    it("keeps the thread's own agent's finished work its own while another agent works", () => {
      const response = {
        id: "response-entry",
        kind: "message" as const,
        createdAt: at(3),
        message: {
          id: MessageId.make("response"),
          role: "assistant" as const,
          text: "Fixed the lock.",
          turnId: "turn-1" as never,
          createdAt: at(3),
          completedAt: at(3),
          streaming: false,
        },
      };
      const toAstra = {
        ...userEntry,
        id: "to-astra-entry",
        createdAt: at(4),
        message: { ...userEntry.message, id: MessageId.make("to-astra"), createdAt: at(4) },
      };
      const astraStep = { ...step("astra-read", 5) };
      astraStep.entry = { ...astraStep.entry, turnId: "turn-2" as never };
      const rows = derive([userEntry, step("read", 2), response, toAstra, astraStep], [], {
        agent: astra,
        working: true,
      });
      expect(layout(rows)).toEqual([
        "user-entry",
        "read",
        "response-entry",
        "to-astra-entry",
        "astra-read",
        "working-indicator-row",
      ]);
      // Astra is at work; the earlier turn is still the thread's own agent's.
      expect(lines(rows)).toEqual([
        null,
        "start own named",
        "end own",
        null,
        "start agent-astra named",
        "end agent-astra",
      ]);
    });

    it("names a side answer posted after the stretch at its first step", () => {
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
      const sideStep = { ...step("side-read", 12).entry, turnId: null };
      const rows = derive(
        [userEntry, step("read", 2), response],
        [exchange({ answeredAt: 13, steps: [sideStep] })],
        { working: false },
      );
      expect(layout(rows)).toEqual([
        "user-entry",
        "read",
        "question-side-1",
        "side-status:side-1 answered-below",
        "response-entry",
        "side-steps:side-1",
        "side-answer:side-1",
      ]);
      expect(lines(rows)).toEqual([
        null,
        "start own named",
        "through own",
        "through own",
        "end own",
        // Its own stretch: named at its steps, bending into its answer.
        "start agent-astra named",
        "end agent-astra",
      ]);
    });

    it("keeps an exchange on the asker's line when its turn stopped right after asking", () => {
      // Asked through a room tool: the question says who asked.
      const asked = {
        ...question(sideTurnId, at(5)),
        fromAgent: { participantId: null },
        requestKind: "ask" as const,
      };
      const rows = derive(
        [userEntry, step("read", 2), step("review-call", 4)],
        [exchange({ askedBy: { participantId: null }, question: asked, answeredAt: 8 })],
        { working: false },
      );
      expect(layout(rows)).toEqual(["user-entry", "read", "question-side-1", "side-answer:side-1"]);
      expect(lines(rows)).toEqual([
        null,
        "start own named",
        "through own",
        "through agent-astra named nested-single",
      ]);
    });
  });
});
