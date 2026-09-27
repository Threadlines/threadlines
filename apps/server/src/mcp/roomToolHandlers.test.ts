import { describe, expect, it } from "@effect/vitest";
import {
  EMPTY_AGENT_REQUEST_STATE,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RoomAgentRequestId,
  SideTurnId,
  ThreadId,
  ThreadParticipantId,
  TurnId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as Duration from "effect/Duration";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import type { McpInvocationScope } from "./McpSessionRegistry.ts";
import { makeRoomRequestRegistry } from "./roomRequests.ts";
import { type RoomToolName, roomToolsFor } from "./roomToolAccess.ts";
import { makeRoomToolHandlers, sideAnswerMessageId } from "./roomToolHandlers.ts";

const THREAD = ThreadId.make("0f8f5a52-4d0e-4c1b-9d56-1e7c1f9b7a01");
const REVIEWER = ThreadParticipantId.make("6f1c9a3e-2b7d-4a55-8e0f-9c3d2b1a0e44");
const CURSOR_AGENT = ThreadParticipantId.make("7a2d0b4f-3c8e-4b66-9f10-ad4e3c2b1f55");
const TURN = TurnId.make("turn-1");
const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CURSOR = ProviderInstanceId.make("cursor");
const AT = "2026-09-27T10:00:00.000Z";
const HEAD = "a".repeat(40);

const DRIVERS: Record<string, string> = {
  codex: "codex",
  claudeAgent: "claudeAgent",
  cursor: "cursor",
};

/** A room: the thread's own agent (Codex) working, with two added agents. */
const makeThread = (patch: Partial<OrchestrationThread> = {}): OrchestrationThread =>
  ({
    id: THREAD,
    projectId: ProjectId.make("project-1"),
    modelSelection: { instanceId: CODEX, model: "gpt-6-astra" },
    participants: [
      {
        id: REVIEWER,
        handle: "Opus 5.5",
        role: "Reviewer",
        modelSelection: { instanceId: CLAUDE, model: "claude-opus-5-5" },
        joinedAt: AT,
        leftAt: null,
      },
      {
        id: CURSOR_AGENT,
        handle: "Composer",
        modelSelection: { instanceId: CURSOR, model: "composer-2" },
        joinedAt: AT,
        leftAt: null,
      },
    ],
    session: {
      threadId: THREAD,
      status: "running",
      providerName: "codex",
      runtimeMode: "full-access",
      participantId: null,
      activeTurnId: TURN,
      lastError: null,
      updatedAt: AT,
    },
    sideTurn: null,
    agentRequests: EMPTY_AGENT_REQUEST_STATE,
    messages: [],
    effectiveCwd: null,
    worktreePath: "/checkout",
    ...patch,
  }) as unknown as OrchestrationThread;

const mainCaller = (
  tools: ReadonlyArray<RoomToolName> = roomToolsFor(undefined),
): McpInvocationScope => ({
  threadId: THREAD,
  sessionKey: THREAD,
  participantId: null,
  generation: 1,
  agentId: "agent-test",
  browser: true,
  roomTools: new Set(tools),
});

const sideCaller = (kind: "ask" | "review"): McpInvocationScope => ({
  ...mainCaller(roomToolsFor(kind)),
  participantId: REVIEWER,
  side: { sideTurnId: SideTurnId.make("11111111-2222-4333-8444-555555555555"), kind },
  browser: false,
});

const settledEvent = (payload: Record<string, unknown>) =>
  ({
    type: "thread.side-turn-settled",
    payload: { threadId: THREAD, ...payload },
  }) as unknown as OrchestrationEvent;

/**
 * A room over a fake engine: records every command, publishes events, and
 * lets a test answer a submit the way the orchestration core would.
 */
const makeRoom = (options: {
  readonly thread?: OrchestrationThread;
  readonly onSubmit?: (
    command: Extract<OrchestrationCommand, { type: "thread.agent-request.submit" }>,
  ) => { readonly events?: ReadonlyArray<OrchestrationEvent>; readonly answer?: string } | "reject";
}) =>
  Effect.gen(function* () {
    let thread = options.thread ?? makeThread();
    const dispatched: OrchestrationCommand[] = [];
    const pubsub = yield* PubSub.unbounded<OrchestrationEvent>();
    const scope = yield* Effect.scope;
    const handlers = makeRoomToolHandlers({
      engine: {
        dispatch: (command) =>
          Effect.gen(function* () {
            dispatched.push(command);
            if (command.type === "thread.agent-request.submit" && options.onSubmit) {
              const reaction = options.onSubmit(command);
              if (reaction === "reject") {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "The user stopped the agents.",
                });
              }
              if (reaction.answer !== undefined && command.sideTurnId !== undefined) {
                const answer: OrchestrationMessage = {
                  id: sideAnswerMessageId(command.sideTurnId),
                  role: "assistant",
                  text: reaction.answer,
                  participantId: command.to.participantId,
                  sideTurnId: command.sideTurnId,
                  turnId: null,
                  streaming: false,
                  createdAt: AT,
                  updatedAt: AT,
                };
                thread = { ...thread, messages: [...thread.messages, answer] };
              }
              yield* PubSub.publishAll(pubsub, reaction.events ?? []);
            }
            return { sequence: dispatched.length };
          }),
        subscribeDomainEvents: Effect.map(PubSub.subscribe(pubsub), Stream.fromSubscription),
      },
      readThread: () => Effect.sync(() => thread),
      readProjectRoot: () => Effect.succeed("/project"),
      driverKindOf: (instanceId) =>
        Effect.succeed(
          DRIVERS[instanceId] !== undefined
            ? ProviderDriverKind.make(DRIVERS[instanceId])
            : undefined,
        ),
      modelNameOf: (selection) =>
        Effect.succeed(selection.model === "gpt-6-astra" ? "GPT-6 Astra" : selection.model),
      git: {
        // Only ever asked to resolve HEAD here.
        execute: () =>
          Effect.succeed({
            exitCode: 0 as never,
            stdout: `${HEAD}\n`,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        workingTreeDiff: () =>
          Effect.succeed({
            diff: "diff --git a/a.ts b/a.ts\n+one\ndiff --git a/b.ts b/b.ts\n+two\n",
          }),
      },
      requests: makeRoomRequestRegistry(scope),
    });
    return {
      handlers,
      dispatched,
      publish: (event: OrchestrationEvent) => PubSub.publish(pubsub, event),
      setThread: (next: OrchestrationThread) => {
        thread = next;
      },
    };
  });

const submits = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
  dispatched.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.agent-request.submit" }> =>
      command.type === "thread.agent-request.submit",
  );

/** Let forked request fibers run until `done` holds. */
const until = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let round = 0; round < 200 && !done(); round += 1) {
      yield* Effect.yieldNow;
    }
  });

describe("room_ask", () => {
  it.effect("brings the other agent's answer back into the call", () =>
    Effect.gen(function* () {
      const room = yield* makeRoom({
        onSubmit: (command) => ({
          answer: "The migration is safe.",
          events: [
            settledEvent({
              sideTurnId: command.sideTurnId,
              outcome: "completed",
              answerMessageId: sideAnswerMessageId(command.sideTurnId!),
            }),
          ],
        }),
      });

      const result = yield* room.handlers.room_ask(mainCaller(), {
        agent: "reviewer",
        question: "Is the migration safe?",
      });

      const [submit] = submits(room.dispatched);
      expect(submit).toMatchObject({
        kind: "ask",
        from: { participantId: null },
        to: { participantId: REVIEWER },
        callerTurnId: TURN,
        chainEpoch: 0,
        message: { text: "Is the migration safe?" },
      });
      expect(result).toEqual({
        outcome: "answered",
        agent: { key: REVIEWER, name: "Opus 5.5 (Reviewer)" },
        requestId: submit!.requestId,
        sideTurnId: submit!.sideTurnId,
        answer: "The migration is safe.",
        answerMessageId: sideAnswerMessageId(submit!.sideTurnId!),
      });
    }),
  );

  it.effect("refuses with the room's precise reason and starts nothing", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        readonly thread?: OrchestrationThread;
        readonly caller?: McpInvocationScope;
        readonly agent?: string;
        readonly outcome: string;
      }> = [
        // Not in its own turn.
        {
          thread: makeThread({
            session: { ...makeThread().session!, activeTurnId: null, status: "ready" },
          }),
          outcome: "refused",
        },
        // Another agent holds the slot.
        {
          thread: makeThread({ session: { ...makeThread().session!, participantId: REVIEWER } }),
          outcome: "refused",
        },
        // A side answer is already running.
        {
          thread: makeThread({
            sideTurn: {
              sideTurnId: SideTurnId.make("22222222-3333-4444-8555-666666666666"),
              participantId: CURSOR_AGENT,
              messageId: MessageId.make("m-side"),
              status: "running",
              startedAt: AT,
            },
          }),
          outcome: "busy",
        },
        // The agents used their requests.
        {
          thread: makeThread({
            agentRequests: { ...EMPTY_AGENT_REQUEST_STATE, requestsSinceUser: 3 },
          }),
          outcome: "limit",
        },
        // The user pressed Stop.
        {
          thread: makeThread({ agentRequests: { ...EMPTY_AGENT_REQUEST_STATE, hold: true } }),
          outcome: "refused",
        },
        // Cursor has no side answers.
        { agent: "Composer", outcome: "refused" },
        // Not an agent in this room.
        { agent: "nobody", outcome: "refused" },
        // A side runtime cannot start requests.
        { caller: sideCaller("ask"), outcome: "refused" },
      ];
      for (const entry of cases) {
        const room = yield* makeRoom(entry.thread !== undefined ? { thread: entry.thread } : {});
        const result = yield* room.handlers.room_ask(entry.caller ?? mainCaller(), {
          agent: entry.agent ?? "Opus 5.5",
          question: "Anything?",
        });
        expect(result.outcome).toBe(entry.outcome);
        expect(result.detail).toBeTruthy();
        expect(room.dispatched).toEqual([]);
      }
    }),
  );

  it.effect("reports a submit the decider refuses anyway", () =>
    Effect.gen(function* () {
      const room = yield* makeRoom({ onSubmit: () => "reject" });
      const result = yield* room.handlers.room_ask(mainCaller(), {
        agent: "Opus 5.5",
        question: "Anything?",
      });
      expect(result).toMatchObject({ outcome: "failed", detail: "The user stopped the agents." });
    }),
  );

  it.effect("joins an identical open call, and one waiter leaving does not stop it", () =>
    Effect.gen(function* () {
      const room = yield* makeRoom({ onSubmit: () => ({}) });
      const ask = room.handlers.room_ask(mainCaller(), { agent: "Opus 5.5", question: "Why?" });
      const first = yield* Effect.forkChild(ask);
      const second = yield* Effect.forkChild(ask);
      yield* until(() => submits(room.dispatched).length > 0);
      yield* Fiber.interrupt(first);

      const [submit] = submits(room.dispatched);
      yield* room.publish(settledEvent({ sideTurnId: submit!.sideTurnId, outcome: "interrupted" }));
      const result = yield* Fiber.join(second);

      expect(submits(room.dispatched)).toHaveLength(1);
      expect(result.outcome).toBe("stopped");
      expect(room.dispatched.some((command) => command.type === "thread.side-turn.interrupt")).toBe(
        false,
      );

      // A different question in the same turn is a request of its own.
      const other = yield* Effect.forkChild(
        room.handlers.room_ask(mainCaller(), { agent: "Opus 5.5", question: "And how?" }),
      );
      yield* until(() => submits(room.dispatched).length > 1);
      expect(submits(room.dispatched)).toHaveLength(2);
      yield* Fiber.interrupt(other);
    }),
  );

  it.effect("stops the side turn when the last waiter leaves", () =>
    Effect.gen(function* () {
      const room = yield* makeRoom({ onSubmit: () => ({}) });
      const waiter = yield* Effect.forkChild(
        room.handlers.room_ask(mainCaller(), { agent: "Opus 5.5", question: "Why?" }),
      );
      yield* until(() => submits(room.dispatched).length > 0);
      yield* Fiber.interrupt(waiter);
      yield* until(() => room.dispatched.some((c) => c.type === "thread.side-turn.interrupt"));

      const [submit] = submits(room.dispatched);
      expect(room.dispatched.find((c) => c.type === "thread.side-turn.interrupt")).toMatchObject({
        threadId: THREAD,
        sideTurnId: submit!.sideTurnId,
      });
    }),
  );

  it.effect("stops the side turn at its deadline and says so", () =>
    Effect.gen(function* () {
      const room = yield* makeRoom({ onSubmit: () => ({}) });
      const waiter = yield* Effect.forkChild(
        room.handlers.room_ask(mainCaller(), { agent: "Opus 5.5", question: "Why?" }),
      );
      yield* until(() => submits(room.dispatched).length > 0);
      yield* TestClock.adjust(Duration.minutes(10));
      const result = yield* Fiber.join(waiter);

      expect(result.outcome).toBe("timeout");
      expect(room.dispatched.at(-1)).toMatchObject({
        type: "thread.side-turn.interrupt",
        sideTurnId: submits(room.dispatched)[0]!.sideTurnId,
      });
    }),
  );
});

describe("room_review", () => {
  it.effect("hands the reviewer the captured basis and nothing of the conversation", () =>
    Effect.gen(function* () {
      const room = yield* makeRoom({
        onSubmit: (command) => ({
          answer: "One defect: a.ts:1.",
          events: [
            settledEvent({
              sideTurnId: command.sideTurnId,
              outcome: "completed",
              answerMessageId: sideAnswerMessageId(command.sideTurnId!),
            }),
          ],
        }),
      });
      const result = yield* room.handlers.room_review(mainCaller(), {
        agent: REVIEWER,
        request: "Check the retry logic.",
      });

      const [submit] = submits(room.dispatched);
      expect(submit).toMatchObject({
        kind: "review",
        message: { text: "Check the retry logic." },
        reviewInput: { basis: { kind: "uncommitted", base: HEAD, files: 2, truncated: false } },
      });
      expect(submit!.reviewInput!.diff).toContain("+two");
      expect(result).toMatchObject({ outcome: "answered", answer: "One defect: a.ts:1." });

      // The reviewer's own credential reads the checkout, never the room.
      const history = yield* room.handlers.room_history(sideCaller("review"), {});
      expect(history.outcome).toBe("refused");
    }),
  );
});

describe("room_hand_off", () => {
  it.effect("queues at once, and the same hand-off in the same turn is not made twice", () =>
    Effect.gen(function* () {
      const room = yield* makeRoom({ onSubmit: () => ({}) });
      const result = yield* room.handlers.room_hand_off(mainCaller(), {
        agent: "Composer",
        message: "Take the UI from here.",
      });
      const [submit] = submits(room.dispatched);
      expect(result).toEqual({
        outcome: "queued",
        agent: { key: CURSOR_AGENT, name: "Composer" },
        requestId: submit!.requestId,
      });
      expect(submit).toMatchObject({ kind: "hand_off", to: { participantId: CURSOR_AGENT } });
      expect(submit!.sideTurnId).toBeUndefined();

      // The core has recorded it as pending on the caller's turn.
      room.setThread(
        makeThread({
          agentRequests: {
            ...EMPTY_AGENT_REQUEST_STATE,
            requestsSinceUser: 1,
            open: [
              {
                requestId: submit!.requestId,
                kind: "hand_off",
                from: { participantId: null },
                to: { participantId: CURSOR_AGENT },
                callerTurnId: TURN,
                chainEpoch: 0,
                status: "pending",
                requestMessageId: submit!.message.messageId,
                createdAt: AT,
              },
            ],
          },
          messages: [
            {
              id: submit!.message.messageId,
              role: "user",
              text: "Take the UI from here.",
              participantId: CURSOR_AGENT,
              fromAgent: { participantId: null },
              requestId: submit!.requestId,
              requestKind: "hand_off",
              turnId: null,
              streaming: false,
              createdAt: AT,
              updatedAt: AT,
            },
          ],
        }),
      );
      const again = yield* room.handlers.room_hand_off(mainCaller(), {
        agent: "Composer",
        message: "Take the UI from here.",
      });
      expect(again).toMatchObject({ outcome: "queued", requestId: submit!.requestId });
      expect(submits(room.dispatched)).toHaveLength(1);
    }),
  );
});

describe("room_agents and room_history", () => {
  it.effect("names every agent, who is working, and which one is the caller", () =>
    Effect.gen(function* () {
      const room = yield* makeRoom({});
      const result = yield* room.handlers.room_agents(sideCaller("ask"));
      // A side runtime is not listed room_agents; the main runtime is.
      expect(result.outcome).toBe("refused");
      const listed = yield* room.handlers.room_agents(mainCaller());
      expect(listed.agents).toEqual([
        {
          key: "primary",
          participantId: null,
          name: "GPT-6 Astra",
          model: "gpt-6-astra",
          status: "working",
          canAnswer: true,
          you: true,
        },
        {
          key: REVIEWER,
          participantId: REVIEWER,
          name: "Opus 5.5 (Reviewer)",
          model: "claude-opus-5-5",
          status: "idle",
          canAnswer: true,
          you: false,
        },
        {
          key: CURSOR_AGENT,
          participantId: CURSOR_AGENT,
          name: "Composer",
          model: "composer-2",
          status: "idle",
          canAnswer: false,
          you: false,
        },
      ]);
    }),
  );

  it.effect("labels who said what to whom, and pages back by sequence", () =>
    Effect.gen(function* () {
      const sideTurnId = SideTurnId.make("33333333-4444-4555-8666-777777777777");
      const message = (
        sequence: number,
        patch: Partial<OrchestrationMessage> & Pick<OrchestrationMessage, "role" | "text">,
      ): OrchestrationMessage => ({
        id: MessageId.make(`m-${sequence}`),
        eventSequence: sequence,
        turnId: null,
        streaming: false,
        createdAt: AT,
        updatedAt: AT,
        ...patch,
      });
      const room = yield* makeRoom({
        thread: makeThread({
          messages: [
            message(1, { role: "user", text: "Fix the login bug." }),
            message(2, { role: "assistant", text: "Fixed it." }),
            message(3, {
              role: "user",
              text: "Is the fix safe?",
              participantId: REVIEWER,
              fromAgent: { participantId: null },
              requestId: RoomAgentRequestId.make("r-1"),
              requestKind: "ask",
              sideTurnId,
            }),
            message(4, {
              role: "assistant",
              text: "Yes.",
              participantId: REVIEWER,
              sideTurnId,
              attachments: [
                {
                  type: "file",
                  kind: "text",
                  id: "att-1" as never,
                  name: "notes.md",
                  mimeType: "text/markdown",
                  sizeBytes: 12,
                },
              ],
            }),
          ],
        }),
      });

      const page = yield* room.handlers.room_history(sideCaller("ask"), { limit: 2 });
      expect(page.messages).toEqual([
        {
          messageId: "m-3",
          sequence: 3,
          at: AT,
          author: "GPT-6 Astra",
          to: "Opus 5.5 (Reviewer)",
          origin: "agent",
          requestKind: "ask",
          onTheSide: true,
          text: "Is the fix safe?",
        },
        {
          messageId: "m-4",
          sequence: 4,
          at: AT,
          author: "Opus 5.5 (Reviewer)",
          to: "GPT-6 Astra",
          origin: "agent",
          onTheSide: true,
          text: "Yes.",
          attachments: [
            { type: "file", name: "notes.md", mimeType: "text/markdown", sizeBytes: 12 },
          ],
        },
      ]);
      expect(page.before).toBe(3);

      const older = yield* room.handlers.room_history(mainCaller(), { before: 3, limit: 20 });
      expect(older.messages.map((entry) => [entry.author, entry.to, entry.origin])).toEqual([
        ["User", "GPT-6 Astra", "user"],
        ["GPT-6 Astra", undefined, "agent"],
      ]);
      expect(older.before).toBeNull();
    }),
  );
});
