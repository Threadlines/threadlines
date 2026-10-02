import { describe, expect, it } from "@effect/vitest";
import {
  type AgentInvitesMode,
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
  type ServerProvider,
  SideTurnId,
  ThreadId,
  ThreadParticipantId,
  TurnId,
} from "@threadlines/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
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
import { ROOM_REQUEST_DEADLINE } from "./roomToolTimeouts.ts";

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
  /** Held until this completes: a slow review capture. */
  readonly captureGate?: Deferred.Deferred<void>;
  readonly onSubmit?: (
    command: Extract<OrchestrationCommand, { type: "thread.agent-request.submit" }>,
  ) => { readonly events?: ReadonlyArray<OrchestrationEvent>; readonly answer?: string } | "reject";
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly invitesMode?: AgentInvitesMode;
  /** The decider refuses to let an answer outrun its call (it just settled). */
  readonly refuseDetach?: boolean;
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
            if (command.type === "thread.agent-request.detach" && options.refuseDetach) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "It is not waiting on its call.",
              });
            }
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
      // The Cursor agent runs where the room tools cannot reach it.
      roomToolsOf: (sessionKey) => Effect.succeed(!sessionKey.endsWith(CURSOR_AGENT)),
      driverKindOf: (instanceId) =>
        Effect.succeed(
          DRIVERS[instanceId] !== undefined
            ? ProviderDriverKind.make(DRIVERS[instanceId])
            : undefined,
        ),
      modelNameOf: (selection) =>
        Effect.succeed(selection.model === "gpt-6-astra" ? "GPT-6 Astra" : selection.model),
      providers: Effect.succeed(options.providers ?? []),
      invitesMode: Effect.succeed(options.invitesMode ?? "ask"),
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
          (options.captureGate !== undefined
            ? Deferred.await(options.captureGate)
            : Effect.void
          ).pipe(
            Effect.as({
              diff: "diff --git a/a.ts b/a.ts\n+one\ndiff --git a/b.ts b/b.ts\n+two\n",
            }),
          ),
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

  it.effect("lets an answer outrun its call, to come back as a message", () =>
    Effect.gen(function* () {
      const room = yield* makeRoom({ onSubmit: () => ({}) });
      const waiter = yield* Effect.forkChild(
        room.handlers.room_ask(mainCaller(), { agent: "Opus 5.5", question: "Why?" }),
      );
      yield* until(() => submits(room.dispatched).length > 0);
      yield* TestClock.adjust(ROOM_REQUEST_DEADLINE);
      const result = yield* Fiber.join(waiter);

      expect(result.outcome).toBe("continuing");
      const [submit] = submits(room.dispatched);
      expect(room.dispatched.at(-1)).toMatchObject({
        type: "thread.agent-request.detach",
        requestId: submit!.requestId,
      });
      // The answer goes on: nothing stops or closes it.
      expect(
        room.dispatched.some(
          (c) =>
            c.type === "thread.side-turn.interrupt" || c.type === "thread.agent-request.settle",
        ),
      ).toBe(false);
    }),
  );

  it.effect("returns an answer that lands just as its time runs out", () =>
    Effect.gen(function* () {
      const room = yield* makeRoom({ onSubmit: () => ({}), refuseDetach: true });
      const waiter = yield* Effect.forkChild(
        room.handlers.room_ask(mainCaller(), { agent: "Opus 5.5", question: "Why?" }),
      );
      yield* until(() => submits(room.dispatched).length > 0);
      const [submit] = submits(room.dispatched);
      yield* TestClock.adjust(ROOM_REQUEST_DEADLINE);
      yield* until(() => room.dispatched.some((c) => c.type === "thread.agent-request.detach"));
      // Refused because the answer settled meanwhile; its settle arrives now.
      yield* room.publish(settledEvent({ sideTurnId: submit!.sideTurnId, outcome: "completed" }));
      const result = yield* Fiber.join(waiter);

      expect(result.outcome).toBe("answered");
      expect(room.dispatched.some((c) => c.type === "thread.side-turn.interrupt")).toBe(false);
    }),
  );

  it.effect("stops the side turn when its time runs out and it cannot go on", () =>
    Effect.gen(function* () {
      const room = yield* makeRoom({ onSubmit: () => ({}), refuseDetach: true });
      const waiter = yield* Effect.forkChild(
        room.handlers.room_ask(mainCaller(), { agent: "Opus 5.5", question: "Why?" }),
      );
      yield* until(() => submits(room.dispatched).length > 0);
      yield* TestClock.adjust(ROOM_REQUEST_DEADLINE);
      yield* until(() => room.dispatched.some((c) => c.type === "thread.agent-request.detach"));
      yield* TestClock.adjust(Duration.seconds(3));
      const result = yield* Fiber.join(waiter);

      expect(result.outcome).toBe("timeout");
      // Recorded as a timeout first, so the chat says so, then stopped.
      expect(room.dispatched.slice(-2)).toMatchObject([
        {
          type: "thread.agent-request.settle",
          requestId: submits(room.dispatched)[0]!.requestId,
          outcome: "timeout",
        },
        {
          type: "thread.side-turn.interrupt",
          sideTurnId: submits(room.dispatched)[0]!.sideTurnId,
        },
      ]);
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

describe("request lifecycle", () => {
  it.effect("sends nothing when the caller leaves while a review is still being captured", () =>
    Effect.gen(function* () {
      const captureGate = yield* Deferred.make<void>();
      const room = yield* makeRoom({ captureGate, onSubmit: () => ({}) });
      const waiter = yield* Effect.forkChild(
        room.handlers.room_review(mainCaller(), { agent: "Opus 5.5", request: "Check it." }),
      );
      yield* until(() => false);
      yield* Fiber.interrupt(waiter);
      yield* Deferred.succeed(captureGate, undefined);
      yield* until(() => false);

      // Nothing was asked for, so none of the room's requests is spent.
      expect(room.dispatched).toEqual([]);
    }),
  );

  it.effect("ends open requests and their waiters when the server shuts down", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const requests = makeRoomRequestRegistry(scope);
      const waiter = yield* Effect.forkChild(requests.join("key", () => Effect.never));
      yield* until(() => false);
      expect(yield* requests.openCount).toBe(1);

      yield* Scope.close(scope, Exit.void);
      yield* Fiber.await(waiter);
      expect(yield* requests.openCount).toBe(0);
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
          roomTools: "attached",
          you: true,
        },
        {
          key: REVIEWER,
          participantId: REVIEWER,
          name: "Opus 5.5 (Reviewer)",
          model: "claude-opus-5-5",
          status: "idle",
          canAnswer: true,
          roomTools: "attached",
          you: false,
        },
        {
          key: CURSOR_AGENT,
          participantId: CURSOR_AGENT,
          name: "Composer",
          model: "composer-2",
          status: "idle",
          canAnswer: false,
          roomTools: "unavailable",
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

describe("room_available_agents and room_invite", () => {
  const provider = (
    instanceId: ProviderInstanceId,
    driver: string,
    auth: ServerProvider["auth"],
    models: ReadonlyArray<{ slug: string; shortName: string }>,
  ) =>
    ({
      instanceId,
      driver,
      enabled: true,
      installed: true,
      status: "ready",
      auth,
      models: models.map((model) => ({ ...model, name: model.shortName, isCustom: false })),
    }) as unknown as ServerProvider;
  const PROVIDERS = [
    provider(CODEX, "codex", { status: "authenticated", type: "chatgpt", label: "ChatGPT Pro" }, [
      { slug: "gpt-6-astra", shortName: "GPT-6 Astra" },
    ]),
    provider(CLAUDE, "claudeAgent", { status: "authenticated", type: "apiKey", label: "API Key" }, [
      { slug: "claude-opus-5-5", shortName: "Opus 5.5" },
    ]),
    // Signed out, and a driver that cannot review: neither is offered.
    provider(ProviderInstanceId.make("claude-work"), "claudeAgent", { status: "unauthenticated" }, [
      { slug: "claude-fable-5-1", shortName: "Fable 5.1" },
    ]),
    provider(CURSOR, "cursor", { status: "authenticated" }, [
      { slug: "composer-2", shortName: "Composer" },
    ]),
  ];
  const plain = makeThread({ participants: [] });

  it.effect("offers signed-in Codex and Claude models, and asks the user for one", () =>
    Effect.gen(function* () {
      const room = yield* makeRoom({ thread: plain, providers: PROVIDERS });
      const available = yield* room.handlers.room_available_agents(mainCaller());
      expect(available).toMatchObject({
        outcome: "ok",
        invites: "ask",
        providers: [
          {
            billing: "Codex · ChatGPT Pro",
            perUse: false,
            models: [{ key: "codex/gpt-6-astra", inThread: true }],
          },
          {
            billing: "Claude · API Key",
            perUse: true,
            models: [{ key: "claudeAgent/claude-opus-5-5", name: "Opus 5.5", inThread: false }],
          },
        ],
      });

      const result = yield* room.handlers.room_invite(mainCaller(), {
        agent: "opus 5.5",
        request: "Check the retry math.",
        reason: "A second model should check this.",
      });
      expect(result).toMatchObject({ outcome: "asked_user", agent: { name: "Opus 5.5" } });
      const [submit] = submits(room.dispatched);
      expect(submit).toMatchObject({
        kind: "invite",
        callerTurnId: TURN,
        message: { text: "Check the retry math." },
        reviewInput: { basis: { kind: "uncommitted", files: 2 } },
        invite: {
          guest: {
            handle: "Opus 5.5",
            modelSelection: { instanceId: CLAUDE, model: "claude-opus-5-5" },
          },
          suggestion: "review",
          billing: { perUse: true },
        },
      });
      expect(submit?.invite?.autoChoice).toBeUndefined();
    }),
  );

  it.effect("invites a model the thread had as a guest back under the same guest", () =>
    Effect.gen(function* () {
      const guest = {
        id: REVIEWER,
        handle: "Opus 5.5",
        modelSelection: { instanceId: CLAUDE, model: "claude-opus-5-5" },
        joinedAt: AT,
        leftAt: AT,
        guest: true,
      };
      const room = yield* makeRoom({
        thread: makeThread({ participants: [guest] }),
        providers: PROVIDERS,
      });
      const result = yield* room.handlers.room_invite(mainCaller(), {
        agent: "Opus 5.5",
        request: "Check the retry math again.",
        reason: "A second look.",
      });
      expect(result).toMatchObject({ outcome: "asked_user", agent: { name: "Opus 5.5" } });
      expect(submits(room.dispatched)[0]).toMatchObject({
        to: { participantId: REVIEWER },
        invite: { guest: { handle: "Opus 5.5" } },
      });
    }),
  );

  it.effect("starts at once without asking, and refuses everything when turned off", () =>
    Effect.gen(function* () {
      const auto = yield* makeRoom({ thread: plain, providers: PROVIDERS, invitesMode: "auto" });
      const started = yield* auto.handlers.room_invite(mainCaller(), {
        agent: "claudeAgent/claude-opus-5-5",
        request: "Check the retry math.",
        reason: "A second model should check this.",
        suggestion: "teammate",
      });
      expect(started.outcome).toBe("started");
      expect(submits(auto.dispatched)[0]?.invite?.autoChoice).toBe("teammate");

      const off = yield* makeRoom({ thread: plain, providers: PROVIDERS, invitesMode: "off" });
      expect((yield* off.handlers.room_available_agents(mainCaller())).outcome).toBe("refused");
      const refused = yield* off.handlers.room_invite(mainCaller(), {
        agent: "Opus 5.5",
        request: "Check the retry math.",
        reason: "A second model should check this.",
      });
      expect(refused.outcome).toBe("refused");
      expect(off.dispatched).toEqual([]);
    }),
  );
});
