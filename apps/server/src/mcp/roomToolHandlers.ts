/**
 * What the room tools do (docs/design/rooms-slice-2.md, Part B).
 *
 * Every handler starts from the caller's credential (McpInvocationScope): the
 * thread, the calling agent, and for a side runtime its side turn and kind.
 * Nothing the model passes says who it is.
 *
 * Requests (`room_ask`, `room_review`, `room_hand_off`) go through the
 * orchestration engine as `thread.agent-request.submit`, where the decider
 * applies the rules (holder, turn in flight, Stop hold, chain epoch, limit).
 * The same rules are read here first, from the thread as it is when the call
 * arrives (`agentRequestRefusal`), so a refused call gets a precise outcome
 * rather than a bare rejection; if the decider refuses anyway, the call says
 * so. An ask or a review then waits for its side turn to settle, inside the
 * request's own lifecycle (roomRequests.ts), never inside a reactor.
 */
import {
  type AgentInvitesMode,
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  RoomAgentRequestId,
  type RoomAgentRequestKind,
  type RoomAgentRequestOutcome,
  type RoomReviewInput,
  type ServerProvider,
  SideTurnId,
  type ThreadId,
  ThreadParticipantId,
  type TurnId,
} from "@threadlines/contracts";
import {
  activeParticipants,
  nextRoomAgentName,
  participantSessionKey,
} from "@threadlines/shared/threadParticipants";
import { resolveThreadWorkingCwd } from "@threadlines/shared/threadCwd";
import { agentInviteRefusal, agentRequestRefusal } from "@threadlines/shared/roomAgentRequests";
import { randomUUID } from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  inviteBilling,
  inviteProviderName,
  isInvitableProvider,
} from "../orchestration/agentInvites.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpSessionRegistry.ts";
import {
  normalizeAgentName,
  type RoomAgentEntry,
  resolveRoomAgent,
  roomAgentEntries,
  roomAgentEntryFor,
} from "./roomAgents.ts";
import {
  makeRoomGit,
  type RoomDiffView,
  RoomGitError,
  type RoomReviewBasisRequest,
} from "./roomGit.ts";
import { roomHistoryPage } from "./roomHistory.ts";
import type { RoomRequestRegistry } from "./roomRequests.ts";
import type { RoomToolName } from "./roomToolAccess.ts";
import { ROOM_REQUEST_DEADLINE, ROOM_TOOL_CALL_TIMEOUT } from "./roomToolTimeouts.ts";
import type {
  RoomAgentsResult,
  RoomAnswerResult,
  RoomAvailableAgentsResult,
  RoomDiffResult,
  RoomHandOffResult,
  RoomHistoryResult,
  RoomInviteResult,
} from "./roomTools.ts";

/** Drivers that can answer on the side (they have side runtimes). */
const SIDE_ANSWER_DRIVERS: ReadonlySet<string> = new Set(["codex", "claudeAgent"]);

/**
 * How long each provider waits on one tool call before giving up on it.
 * Codex and Claude are given ROOM_TOOL_CALL_TIMEOUT when the room endpoint is
 * attached (roomToolTimeouts.ts). Cursor's agent (2026.05) calls tools
 * with the MCP SDK's default 60s and no way to raise it; fx waits its default
 * operation timeout, 60s, since ACP cannot pass one. A provider missing here
 * is assumed to wait at least the deadline.
 */
export const PROVIDER_TOOL_CALL_LIMIT: Readonly<Record<string, Duration.Duration>> = {
  codex: ROOM_TOOL_CALL_TIMEOUT,
  claudeAgent: ROOM_TOOL_CALL_TIMEOUT,
  cursor: Duration.seconds(60),
  fx: Duration.seconds(60),
};

/** Kept between the deadline and the provider's own limit, so ours answers first. */
const PROVIDER_LIMIT_MARGIN = Duration.seconds(5);

/**
 * How long a call that ran out of time waits for a settle already on its way
 * (the answer landed, or Stop came, as time ran out). Inside the margin.
 */
const DETACH_REFUSED_GRACE = Duration.seconds(3);

/** How much of an answer comes back in the tool result; the rest is in the chat. */
export const ROOM_ANSWER_CHAR_LIMIT = 24_000;

/** An ask's or review's deadline for a caller on `driver`. */
export function roomRequestDeadline(driver: string | undefined): Duration.Duration {
  const limit = driver !== undefined ? PROVIDER_TOOL_CALL_LIMIT[driver] : undefined;
  if (limit === undefined) {
    return ROOM_REQUEST_DEADLINE;
  }
  const withMargin = Duration.subtract(limit, PROVIDER_LIMIT_MARGIN);
  return Duration.min(ROOM_REQUEST_DEADLINE, Duration.max(withMargin, Duration.seconds(30)));
}

/** The side answer message a side turn writes (see ProviderRuntimeIngestion). */
export const sideAnswerMessageId = (sideTurnId: SideTurnId) =>
  MessageId.make(`side-answer:${sideTurnId}`);

/**
 * The checkout a room's tools read: where the working agent is (a worktree it
 * moved into), else the thread's configured checkout.
 */
export function roomCheckoutCwd(
  thread: Pick<OrchestrationThread, "effectiveCwd" | "worktreePath">,
  projectRoot: string | undefined,
): string | undefined {
  return (
    resolveThreadWorkingCwd({
      projectCwd: projectRoot,
      worktreePath: thread.worktreePath,
      effectiveCwd: thread.effectiveCwd,
    }) ?? undefined
  );
}

export interface RoomToolDeps {
  readonly engine: Pick<OrchestrationEngineShape, "dispatch" | "subscribeDomainEvents">;
  readonly readThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined>;
  readonly readProjectRoot: (projectId: ProjectId) => Effect.Effect<string | undefined>;
  readonly driverKindOf: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderDriverKind | undefined>;
  /**
   * What an agent's live runtime reports about the room tools (keyed by its
   * session key): true attached, false asked for but not reachable, undefined
   * no runtime yet or started before the room.
   */
  readonly roomToolsOf: (sessionKey: ThreadId) => Effect.Effect<boolean | undefined>;
  /** A model's name as the model picker shows it. */
  readonly modelNameOf: (selection: ModelSelection) => Effect.Effect<string>;
  /** Another open thread's title, for labelling messages that came from it. */
  readonly threadTitleOf: (threadId: ThreadId) => Effect.Effect<string | undefined>;
  /** The provider snapshots: who could be invited, and how each is paid for. */
  readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
  /** Whether agents may bring in other agents, read live at every call. */
  readonly invitesMode: Effect.Effect<AgentInvitesMode>;
  readonly git: Pick<GitVcsDriverShape, "execute" | "workingTreeDiff">;
  readonly requests: RoomRequestRegistry;
}

interface Room {
  readonly thread: OrchestrationThread;
  readonly entries: ReadonlyArray<RoomAgentEntry>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const clip = (text: string, limit: number) =>
  text.length > limit
    ? { text: `${text.slice(0, limit)}\n[clipped; the full text is in the chat]`, clipped: true }
    : { text, clipped: false };

const dispatchDetail = (error: { readonly message: string }) =>
  "detail" in error && typeof error.detail === "string" ? error.detail : error.message;

const agentLabel = (entry: RoomAgentEntry) => ({ key: entry.key, name: entry.name });

/** How a request's wait ended. */
type Settled =
  | {
      readonly via: "side-turn";
      readonly outcome: "completed" | "failed" | "interrupted";
      readonly answerMessageId?: MessageId | undefined;
      readonly error?: string | undefined;
    }
  | {
      readonly via: "request";
      readonly outcome: RoomAgentRequestOutcome;
      readonly error?: string | undefined;
    };

const settledBy =
  (threadId: ThreadId, requestId: RoomAgentRequestId, sideTurnId: SideTurnId) =>
  (event: OrchestrationEvent): Settled | undefined => {
    if (event.type === "thread.side-turn-settled") {
      return event.payload.threadId === threadId && event.payload.sideTurnId === sideTurnId
        ? {
            via: "side-turn",
            outcome: event.payload.outcome,
            answerMessageId: event.payload.answerMessageId,
            error: event.payload.error,
          }
        : undefined;
    }
    if (event.type === "thread.agent-request-settled") {
      return event.payload.threadId === threadId && event.payload.requestId === requestId
        ? { via: "request", outcome: event.payload.outcome, error: event.payload.error }
        : undefined;
    }
    return undefined;
  };

export function makeRoomToolHandlers(deps: RoomToolDeps) {
  const roomGit = makeRoomGit(deps.git);

  const refused = (detail: string) => ({ outcome: "refused" as const, detail });

  const loadRoom = (scope: McpInvocationScope) =>
    Effect.gen(function* () {
      const thread = yield* deps.readThread(scope.threadId);
      if (thread === undefined) {
        return undefined;
      }
      const primaryModelName = yield* deps.modelNameOf(thread.modelSelection);
      return { thread, entries: roomAgentEntries(thread, primaryModelName) } satisfies Room;
    });

  const notAllowed = (tool: RoomToolName) =>
    tool === "room_history"
      ? "An independent review does not see the room's conversation."
      : tool === "room_available_agents" || tool === "room_invite"
        ? "Only the agent working in this thread can bring in another agent."
        : "Only the agent working in this room can ask another agent.";

  const canAnswerOnTheSide = (entry: RoomAgentEntry) =>
    deps
      .driverKindOf(entry.modelSelection.instanceId)
      .pipe(Effect.map((driver) => driver !== undefined && SIDE_ANSWER_DRIVERS.has(driver)));

  // ---------------------------------------------------------------------------
  // Read tools
  // ---------------------------------------------------------------------------

  const roomAgents = (scope: McpInvocationScope): Effect.Effect<RoomAgentsResult> =>
    Effect.gen(function* () {
      if (!scope.roomTools.has("room_agents")) {
        return { ...refused(notAllowed("room_agents")), agents: [] } satisfies RoomAgentsResult;
      }
      const room = yield* loadRoom(scope);
      if (room === undefined) {
        return { ...refused("This thread is gone."), agents: [] } satisfies RoomAgentsResult;
      }
      const { thread } = room;
      const holder = thread.session?.participantId ?? null;
      const working =
        thread.session !== null &&
        (thread.session.activeTurnId !== null ||
          thread.session.status === "running" ||
          thread.session.status === "starting");
      const answering = thread.sideTurn?.participantId;
      const agents = yield* Effect.forEach(
        room.entries.filter((entry) => entry.present),
        (entry) =>
          Effect.all([
            canAnswerOnTheSide(entry),
            deps.roomToolsOf(participantSessionKey(scope.threadId, entry.participantId)),
          ]).pipe(
            Effect.map(([canAnswer, roomTools]) => ({
              key: entry.key,
              participantId: entry.participantId,
              name: entry.name,
              model: entry.modelSelection.model,
              status:
                working && holder === entry.participantId
                  ? ("working" as const)
                  : answering !== undefined && answering === entry.participantId
                    ? ("answering" as const)
                    : ("idle" as const),
              canAnswer,
              roomTools:
                roomTools === true
                  ? ("attached" as const)
                  : roomTools === false
                    ? ("unavailable" as const)
                    : ("next_turn" as const),
              you: entry.participantId === scope.participantId,
            })),
          ),
      );
      return { outcome: "ok", agents } satisfies RoomAgentsResult;
    });

  /** Titles of the threads this thread's cross-thread messages came from. */
  const titlesOfThreadsIn = (thread: OrchestrationThread) =>
    Effect.gen(function* () {
      const ids = new Set<ThreadId>();
      for (const message of thread.messages) {
        if (message.fromThread !== undefined) ids.add(message.fromThread.threadId);
      }
      const titles = new Map<ThreadId, string>();
      yield* Effect.forEach(
        ids,
        (threadId) =>
          deps.threadTitleOf(threadId).pipe(
            Effect.tap((title) =>
              Effect.sync(() => {
                if (title !== undefined) titles.set(threadId, title);
              }),
            ),
          ),
        { discard: true },
      );
      return titles;
    });

  const roomHistory = (
    scope: McpInvocationScope,
    input: {
      readonly before?: number | undefined;
      readonly limit?: number | undefined;
      readonly query?: string | undefined;
    },
  ): Effect.Effect<RoomHistoryResult> =>
    Effect.gen(function* () {
      if (!scope.roomTools.has("room_history")) {
        return {
          ...refused(notAllowed("room_history")),
          messages: [],
          before: null,
        } satisfies RoomHistoryResult;
      }
      const room = yield* loadRoom(scope);
      if (room === undefined) {
        return {
          ...refused("This thread is gone."),
          messages: [],
          before: null,
        } satisfies RoomHistoryResult;
      }
      const page = roomHistoryPage({
        messages: room.thread.messages,
        entries: room.entries,
        threadTitles: yield* titlesOfThreadsIn(room.thread),
        before:
          input.before !== undefined && Number.isFinite(input.before) ? input.before : undefined,
        limit: input.limit,
        query: input.query,
      });
      return { outcome: "ok", ...page } satisfies RoomHistoryResult;
    });

  const checkoutOf = (thread: OrchestrationThread) =>
    Effect.gen(function* () {
      const projectRoot =
        thread.effectiveCwd === null && thread.worktreePath === null
          ? yield* deps.readProjectRoot(thread.projectId)
          : undefined;
      return roomCheckoutCwd(thread, projectRoot);
    });

  const roomDiff = (
    scope: McpInvocationScope,
    input: {
      readonly view: RoomDiffView;
      readonly base?: string | undefined;
      readonly path?: string | undefined;
    },
  ): Effect.Effect<RoomDiffResult> =>
    Effect.gen(function* () {
      if (!scope.roomTools.has("room_diff")) {
        return refused(notAllowed("room_diff")) satisfies RoomDiffResult;
      }
      const thread = yield* deps.readThread(scope.threadId);
      const cwd = thread !== undefined ? yield* checkoutOf(thread) : undefined;
      if (cwd === undefined) {
        return refused("This room has no checkout to read.") satisfies RoomDiffResult;
      }
      return yield* roomGit.view({ cwd, ...input }).pipe(
        Effect.map((result) => ({ outcome: "ok" as const, ...result }) satisfies RoomDiffResult),
        Effect.catch((error: RoomGitError) =>
          Effect.succeed({
            outcome: error.outcome,
            detail: error.message,
          } satisfies RoomDiffResult),
        ),
      );
    });

  // ---------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------

  interface RequestArrival {
    readonly room: Room;
    readonly target: RoomAgentEntry;
    readonly callerTurnId: TurnId;
  }

  /**
   * Who is asked, and the caller's turn: a request made outside the caller's
   * own turn, or of an agent the room does not have, is refused here.
   */
  const arrive = (
    scope: McpInvocationScope,
    tool: RoomToolName,
    agent: string,
    text: string,
  ): Effect.Effect<RequestArrival | { readonly refused: string }> =>
    Effect.gen(function* () {
      if (!scope.roomTools.has(tool) || scope.side !== undefined) {
        return { refused: notAllowed(tool) };
      }
      if (text.trim().length === 0) {
        return { refused: "Say what you want from the other agent." };
      }
      const room = yield* loadRoom(scope);
      if (room === undefined) {
        return { refused: "This thread is gone." };
      }
      if (activeParticipants(room.thread).length === 0) {
        return { refused: "This thread has no other agents." };
      }
      const resolved = resolveRoomAgent(room.entries, agent);
      if (resolved.kind !== "found") {
        return { refused: resolved.detail };
      }
      const callerTurnId = room.thread.session?.activeTurnId ?? null;
      if (callerTurnId === null) {
        return { refused: "Requests can only be made during your own turn." };
      }
      return { room, target: resolved.entry, callerTurnId };
    });

  /** The shared rules, read from the thread as the call arrived. */
  const precheck = (
    scope: McpInvocationScope,
    kind: RoomAgentRequestKind,
    arrival: RequestArrival,
  ) =>
    agentRequestRefusal(arrival.room.thread, {
      kind,
      from: { participantId: scope.participantId },
      to: { participantId: arrival.target.participantId },
      callerTurnId: arrival.callerTurnId,
      chainEpoch: arrival.room.thread.agentRequests.chainEpoch,
    });

  const submitCommand = (input: {
    readonly scope: McpInvocationScope;
    readonly kind: RoomAgentRequestKind;
    readonly arrival: RequestArrival;
    readonly requestId: RoomAgentRequestId;
    readonly text: string;
    readonly sideTurnId?: SideTurnId;
    readonly reviewInput?: RoomReviewInput;
  }) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      return yield* deps.engine
        .dispatch({
          type: "thread.agent-request.submit",
          commandId: CommandId.make(`server:room-request:${input.requestId}`),
          threadId: input.scope.threadId,
          requestId: input.requestId,
          kind: input.kind,
          from: { participantId: input.scope.participantId },
          to: { participantId: input.arrival.target.participantId },
          callerTurnId: input.arrival.callerTurnId,
          chainEpoch: input.arrival.room.thread.agentRequests.chainEpoch,
          message: { messageId: MessageId.make(randomUUID()), text: input.text },
          ...(input.sideTurnId !== undefined ? { sideTurnId: input.sideTurnId } : {}),
          ...(input.reviewInput !== undefined ? { reviewInput: input.reviewInput } : {}),
          createdAt,
        })
        .pipe(
          Effect.as(undefined),
          Effect.catch((error) => Effect.succeed(dispatchDetail(error))),
        );
    });

  /** Close an ask or review before its side answer settles (a timeout). */
  const settleRequestEarly = (
    threadId: ThreadId,
    requestId: RoomAgentRequestId,
    outcome: "timeout",
    error: string,
  ) =>
    Effect.gen(function* () {
      yield* deps.engine
        .dispatch({
          type: "thread.agent-request.settle",
          commandId: CommandId.make(`server:room-request-timeout:${requestId}`),
          threadId,
          requestId,
          outcome,
          error,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.ignore);
    });

  const interruptSideTurn = (threadId: ThreadId, sideTurnId: SideTurnId) =>
    Effect.gen(function* () {
      yield* deps.engine
        .dispatch({
          type: "thread.side-turn.interrupt",
          commandId: CommandId.make(`server:room-request-interrupt:${randomUUID()}`),
          threadId,
          sideTurnId,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.ignore);
    });

  /** The answer message's text, bounded. */
  const readAnswer = (threadId: ThreadId, messageId: MessageId) =>
    deps
      .readThread(threadId)
      .pipe(Effect.map((thread) => thread?.messages.find((message) => message.id === messageId)));

  const answerResult = (
    scope: McpInvocationScope,
    base: Pick<RoomAnswerResult, "agent" | "requestId" | "sideTurnId">,
    sideTurnId: SideTurnId,
    settled: Settled,
  ) =>
    Effect.gen(function* () {
      const answered =
        (settled.via === "side-turn" && settled.outcome === "completed") ||
        (settled.via === "request" && settled.outcome === "answered");
      if (!answered) {
        const outcome =
          settled.outcome === "failed"
            ? ("failed" as const)
            : settled.outcome === "timeout"
              ? ("timeout" as const)
              : ("stopped" as const);
        return {
          ...base,
          outcome,
          ...(settled.error !== undefined ? { detail: settled.error } : {}),
        } satisfies RoomAnswerResult;
      }
      const messageId =
        (settled.via === "side-turn" ? settled.answerMessageId : undefined) ??
        sideAnswerMessageId(sideTurnId);
      const message = yield* readAnswer(scope.threadId, messageId);
      if (message === undefined || message.text.trim().length === 0) {
        return {
          ...base,
          outcome: "answered",
          answer: "(It finished without writing an answer.)",
        } satisfies RoomAnswerResult;
      }
      const bounded = clip(message.text, ROOM_ANSWER_CHAR_LIMIT);
      return {
        ...base,
        outcome: "answered",
        answer: bounded.text,
        ...(bounded.clipped ? { answerClipped: true } : {}),
        answerMessageId: message.id,
      } satisfies RoomAnswerResult;
    });

  /**
   * Switch an ask or review whose call ran out of time to answering by
   * message. False when the decider refuses: it settled meanwhile, Stop came,
   * or the caller's turn is over.
   */
  const detachRequest = (threadId: ThreadId, requestId: RoomAgentRequestId) =>
    Effect.gen(function* () {
      return yield* deps.engine
        .dispatch({
          type: "thread.agent-request.detach",
          commandId: CommandId.make(`server:room-request-detach:${requestId}`),
          threadId,
          requestId,
          createdAt: yield* nowIso,
        })
        .pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
    });

  /**
   * One ask or review, from the rules to its answer. Runs in the request
   * registry, so a dropped call does not end it; `abandoned` completes when
   * every call waiting on it has gone. An answer that outruns the call goes
   * on, and comes back to the caller as a message (`continuing`).
   */
  const runAnswerRequest = (input: {
    readonly scope: McpInvocationScope;
    readonly kind: "ask" | "review";
    readonly arrival: RequestArrival;
    readonly text: string;
    readonly basis: RoomReviewBasisRequest | undefined;
    readonly abandoned: Effect.Effect<void>;
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scope, kind, arrival } = input;
        const base = { agent: agentLabel(arrival.target) };
        const refusal = precheck(scope, kind, arrival);
        if (refusal !== null) {
          return {
            ...base,
            outcome: refusal.outcome,
            detail: refusal.detail,
          } satisfies RoomAnswerResult;
        }
        if (!(yield* canAnswerOnTheSide(arrival.target))) {
          return {
            ...base,
            outcome: "refused",
            detail: `${arrival.target.name} cannot answer on the side; only Codex and Claude agents can.`,
          } satisfies RoomAnswerResult;
        }
        const caller = roomAgentEntryFor(arrival.room.entries, scope.participantId);
        const deadline = roomRequestDeadline(
          caller !== undefined
            ? yield* deps.driverKindOf(caller.modelSelection.instanceId)
            : undefined,
        );
        const requestId = RoomAgentRequestId.make(randomUUID());
        const sideTurnId = SideTurnId.make(randomUUID());
        const ids = { ...base, requestId, sideTurnId };
        let submitted = false;

        // One clock for the whole call, capture included. The call ends when
        // it runs out, or when the last waiter leaves.
        const clock = yield* Effect.forkScoped(Effect.sleep(deadline));
        const callEnds = Effect.raceFirst(
          Fiber.join(clock).pipe(Effect.as("timeout" as const)),
          input.abandoned.pipe(Effect.as("abandoned" as const)),
        );

        // Listening before the request exists, so its settle cannot slip by,
        // and apart from the call, so an answer that lands just as time runs
        // out is still caught.
        const events = yield* deps.engine.subscribeDomainEvents;
        const listener = yield* Effect.forkScoped(
          events.pipe(
            Stream.map(settledBy(scope.threadId, requestId, sideTurnId)),
            Stream.filter((value): value is Settled => value !== undefined),
            Stream.runHead,
          ),
        );
        const answered = (settled: Option.Option<Settled>) =>
          Option.isNone(settled)
            ? Effect.succeed({
                ...ids,
                outcome: "failed",
                detail: "The server stopped before the answer came.",
              } satisfies RoomAnswerResult)
            : answerResult(scope, ids, sideTurnId, settled.value);

        // A review's capture, then the request. A submit in flight finishes
        // even when the call ends, so `submitted` is right once this returns.
        const send = Effect.gen(function* () {
          let reviewInput: RoomReviewInput | undefined;
          if (kind === "review") {
            const cwd = yield* checkoutOf(arrival.room.thread);
            if (cwd === undefined) {
              return {
                ...base,
                outcome: "failed",
                detail: "This room has no checkout to review.",
              } satisfies RoomAnswerResult;
            }
            const captured = yield* roomGit
              .captureReviewBasis(cwd, input.basis ?? "uncommitted")
              .pipe(Effect.result);
            if (captured._tag === "Failure") {
              return {
                ...base,
                outcome: captured.failure.outcome,
                detail: `The review's basis could not be captured: ${captured.failure.message}`,
              } satisfies RoomAnswerResult;
            }
            reviewInput = captured.success;
          }
          const rejected = yield* submitCommand({
            scope,
            kind,
            arrival,
            requestId,
            text: input.text,
            sideTurnId,
            ...(reviewInput !== undefined ? { reviewInput } : {}),
          }).pipe(
            Effect.tap((rejection) =>
              Effect.sync(() => {
                submitted = rejection === undefined;
              }),
            ),
            Effect.uninterruptible,
          );
          return rejected !== undefined
            ? ({ ...ids, outcome: "failed", detail: rejected } satisfies RoomAnswerResult)
            : ("sent" as const);
        });

        const sent = yield* Effect.raceFirst(send, callEnds);
        if (typeof sent === "object") {
          return sent;
        }
        let ending: "timeout" | "abandoned";
        if (sent === "sent") {
          const waited = yield* Effect.raceFirst(Fiber.join(listener), callEnds);
          if (typeof waited !== "string") {
            return yield* answered(waited);
          }
          ending = waited;
        } else {
          ending = sent;
        }

        // Out of time: the answer goes on and comes back as a message. If the
        // decider refuses that, the request just settled or is being stopped,
        // so its settle is a moment away.
        if (submitted && ending === "timeout") {
          if (yield* detachRequest(scope.threadId, requestId)) {
            const what = kind === "review" ? "review" : "answer";
            return {
              ...ids,
              outcome: "continuing",
              detail: `${arrival.target.name} is still working on it. Its ${what} will come to you as a message when it is done, so carry on or end your turn. Do not ask again.`,
            } satisfies RoomAnswerResult;
          }
          const late = yield* Effect.raceFirst(
            Fiber.join(listener),
            Effect.sleep(DETACH_REFUSED_GRACE).pipe(Effect.as("late" as const)),
          );
          if (late !== "late") {
            return yield* answered(late);
          }
        }
        // Nobody is waiting any more: stop what was started. A timeout is
        // recorded as one first, so the chat says so.
        if (submitted) {
          if (ending === "timeout") {
            yield* settleRequestEarly(
              scope.threadId,
              requestId,
              "timeout",
              `No answer within ${Duration.format(deadline)}.`,
            );
          }
          yield* interruptSideTurn(scope.threadId, sideTurnId);
        }
        return ending === "timeout"
          ? ({
              ...ids,
              outcome: "timeout",
              detail: `No answer within ${Duration.format(deadline)}; it was stopped.`,
            } satisfies RoomAnswerResult)
          : ({
              ...ids,
              outcome: "stopped",
              detail: "The call was dropped.",
            } satisfies RoomAnswerResult);
      }),
    );

  const answerRequest = (input: {
    readonly scope: McpInvocationScope;
    readonly kind: "ask" | "review";
    readonly agent: string;
    readonly text: string;
    readonly basis?: RoomReviewBasisRequest | undefined;
  }): Effect.Effect<RoomAnswerResult> =>
    Effect.gen(function* () {
      const tool = input.kind === "ask" ? "room_ask" : "room_review";
      const arrival = yield* arrive(input.scope, tool, input.agent, input.text);
      if ("refused" in arrival) {
        return refused(arrival.refused) satisfies RoomAnswerResult;
      }
      const basisKey =
        input.basis === undefined || input.basis === "uncommitted"
          ? "uncommitted"
          : `base:${input.basis.base}`;
      const key = [
        input.scope.threadId,
        arrival.callerTurnId,
        input.kind,
        arrival.target.key,
        input.text.trim(),
        input.kind === "review" ? basisKey : "",
      ].join("\u0000");
      return yield* deps.requests.join(key, (abandoned) =>
        runAnswerRequest({
          scope: input.scope,
          kind: input.kind,
          arrival,
          text: input.text.trim(),
          basis: input.basis,
          abandoned,
        }),
      );
    });

  const roomHandOff = (
    scope: McpInvocationScope,
    input: { readonly agent: string; readonly message: string },
  ): Effect.Effect<RoomHandOffResult> =>
    Effect.gen(function* () {
      const arrival = yield* arrive(scope, "room_hand_off", input.agent, input.message);
      if ("refused" in arrival) {
        return refused(arrival.refused) satisfies RoomHandOffResult;
      }
      const text = input.message.trim();
      const base = { agent: agentLabel(arrival.target) };
      // The same hand-off, already made in this turn: that one stands.
      const { thread } = arrival.room;
      const same = thread.agentRequests.open.find(
        (request) =>
          request.kind === "hand_off" &&
          request.callerTurnId === arrival.callerTurnId &&
          (request.from.participantId ?? null) === scope.participantId &&
          (request.to.participantId ?? null) === arrival.target.participantId &&
          thread.messages.find((message) => message.id === request.requestMessageId)?.text === text,
      );
      if (same !== undefined) {
        return {
          ...base,
          outcome: "queued",
          requestId: same.requestId,
        } satisfies RoomHandOffResult;
      }
      const key = [scope.threadId, arrival.callerTurnId, "hand_off", arrival.target.key, text].join(
        "\u0000",
      );
      return yield* deps.requests.join(key, () =>
        Effect.gen(function* () {
          const refusal = precheck(scope, "hand_off", arrival);
          if (refusal !== null) {
            return {
              ...base,
              outcome: refusal.outcome,
              detail: refusal.detail,
            } satisfies RoomHandOffResult;
          }
          const requestId = RoomAgentRequestId.make(randomUUID());
          const rejected = yield* submitCommand({
            scope,
            kind: "hand_off",
            arrival,
            requestId,
            text,
          });
          return rejected !== undefined
            ? ({
                ...base,
                outcome: "failed",
                detail: rejected,
                requestId,
              } satisfies RoomHandOffResult)
            : ({ ...base, outcome: "queued", requestId } satisfies RoomHandOffResult);
        }),
      );
    });

  // ---------------------------------------------------------------------------
  // Invites (docs/design/rooms-agent-invites.md)
  // ---------------------------------------------------------------------------

  const INVITES_OFF = "Bringing in other agents is turned off in Settings.";

  interface InviteCandidate {
    readonly key: string;
    readonly provider: ServerProvider;
    readonly modelSelection: ModelSelection;
    /** As the model picker shows it: "GPT-6 Astra". */
    readonly name: string;
  }

  const inviteCandidates = (providers: ReadonlyArray<ServerProvider>) =>
    providers.filter(isInvitableProvider).flatMap((provider) =>
      provider.models
        .filter((model) => model.isHidden !== true)
        .map((model): InviteCandidate => ({
          key: `${provider.instanceId}/${model.slug}`,
          provider,
          modelSelection: { instanceId: provider.instanceId, model: model.slug },
          name: model.shortName ?? model.name,
        })),
    );

  const sameModel = (left: ModelSelection, right: ModelSelection) =>
    left.instanceId === right.instanceId && left.model === right.model;

  /** The model an invite names: a key wins outright; a name must fit one model. */
  const resolveInviteCandidate = (
    candidates: ReadonlyArray<InviteCandidate>,
    input: string,
  ): InviteCandidate | { readonly refused: string } => {
    const trimmed = input.trim();
    const byKey = candidates.find(
      (candidate) => candidate.key.toLowerCase() === trimmed.toLowerCase(),
    );
    if (byKey !== undefined) {
      return byKey;
    }
    const wanted = normalizeAgentName(trimmed);
    const matches = candidates.filter((candidate) =>
      [
        candidate.name,
        candidate.modelSelection.model,
        `${inviteProviderName(candidate.provider)} ${candidate.name}`,
      ].some((name) => normalizeAgentName(name) === wanted),
    );
    if (matches.length === 1) {
      return matches[0]!;
    }
    const listed = (matches.length > 1 ? matches : candidates)
      .map((candidate) => `${candidate.name} (${candidate.key})`)
      .join(", ");
    return {
      refused:
        matches.length > 1
          ? `"${trimmed}" fits more than one model: ${listed}. Use the key.`
          : wanted.length === 0
            ? `Name a model. Available: ${listed}.`
            : `No available model is called "${trimmed}". Available: ${listed}.`,
    };
  };

  const roomAvailableAgents = (
    scope: McpInvocationScope,
  ): Effect.Effect<RoomAvailableAgentsResult> =>
    Effect.gen(function* () {
      const none = { providers: [] };
      if (!scope.roomTools.has("room_available_agents") || scope.side !== undefined) {
        return { ...refused(notAllowed("room_available_agents")), ...none };
      }
      const mode = yield* deps.invitesMode;
      if (mode === "off") {
        return { ...refused(INVITES_OFF), ...none };
      }
      const room = yield* loadRoom(scope);
      if (room === undefined) {
        return { ...refused("This thread is gone."), ...none };
      }
      const present = room.entries.filter((entry) => entry.present);
      const providers = (yield* deps.providers).filter(isInvitableProvider);
      return {
        outcome: "ok",
        invites: mode,
        providers: providers.map((provider) => {
          const billing = inviteBilling(provider);
          return {
            provider: provider.instanceId,
            name: inviteProviderName(provider),
            billing: billing.label,
            perUse: billing.perUse,
            models: inviteCandidates([provider]).map((candidate) => ({
              key: candidate.key,
              name: candidate.name,
              inThread: present.some((entry) =>
                sameModel(entry.modelSelection, candidate.modelSelection),
              ),
            })),
          };
        }),
      } satisfies RoomAvailableAgentsResult;
    });

  const REASON_CHAR_LIMIT = 300;

  const roomInvite = (
    scope: McpInvocationScope,
    input: {
      readonly agent: string;
      readonly request: string;
      readonly reason: string;
      readonly suggestion?: "review" | "teammate" | undefined;
      readonly basis?: RoomReviewBasisRequest | undefined;
    },
  ): Effect.Effect<RoomInviteResult> =>
    Effect.gen(function* () {
      if (!scope.roomTools.has("room_invite") || scope.side !== undefined) {
        return refused(notAllowed("room_invite")) satisfies RoomInviteResult;
      }
      const text = input.request.trim();
      const reason = input.reason.trim().slice(0, REASON_CHAR_LIMIT).trim();
      if (text.length === 0) {
        return refused("Say what the reviewer should check.") satisfies RoomInviteResult;
      }
      if (reason.length === 0) {
        return refused("Give the user a short reason.") satisfies RoomInviteResult;
      }
      const mode = yield* deps.invitesMode;
      if (mode === "off") {
        return refused(INVITES_OFF) satisfies RoomInviteResult;
      }
      const room = yield* loadRoom(scope);
      if (room === undefined) {
        return refused("This thread is gone.") satisfies RoomInviteResult;
      }
      const target = resolveInviteCandidate(inviteCandidates(yield* deps.providers), input.agent);
      if ("refused" in target) {
        return refused(target.refused) satisfies RoomInviteResult;
      }
      const alreadyHere = room.entries.find(
        (entry) =>
          entry.present &&
          entry.participantId !== null &&
          sameModel(entry.modelSelection, target.modelSelection),
      );
      if (alreadyHere !== undefined) {
        return refused(
          `${alreadyHere.name} is already in this thread. Ask it with room_review.`,
        ) satisfies RoomInviteResult;
      }
      const callerTurnId = room.thread.session?.activeTurnId ?? null;
      if (callerTurnId === null) {
        return refused("Invites can only be made during your own turn.") satisfies RoomInviteResult;
      }
      const suggestion = input.suggestion ?? "review";
      const chainEpoch = room.thread.agentRequests.chainEpoch;
      const rules = {
        from: { participantId: scope.participantId },
        callerTurnId,
        chainEpoch,
        startsNow: mode === "auto",
      };
      const refusal = agentInviteRefusal(room.thread, rules);
      if (refusal !== null) {
        return { outcome: refusal.outcome, detail: refusal.detail } satisfies RoomInviteResult;
      }
      const basisKey =
        input.basis === undefined || input.basis === "uncommitted"
          ? "uncommitted"
          : `base:${input.basis.base}`;
      const key = [scope.threadId, callerTurnId, "invite", target.key, text, basisKey].join(
        "\u0000",
      );
      return yield* deps.requests.join(key, () =>
        Effect.gen(function* () {
          const cwd = yield* checkoutOf(room.thread);
          if (cwd === undefined) {
            return {
              outcome: "failed",
              detail: "This thread has no checkout to review.",
            } satisfies RoomInviteResult;
          }
          const captured = yield* roomGit
            .captureReviewBasis(cwd, input.basis ?? "uncommitted")
            .pipe(Effect.result);
          if (captured._tag === "Failure") {
            return {
              outcome: captured.failure.outcome,
              detail: `The review's basis could not be captured: ${captured.failure.message}`,
            } satisfies RoomInviteResult;
          }
          // The capture takes a while: the setting or the provider's sign-in
          // may have changed since the call arrived, and what is sent must
          // match what the user will be shown.
          const modeNow = yield* deps.invitesMode;
          if (modeNow === "off") {
            return refused(INVITES_OFF) satisfies RoomInviteResult;
          }
          // Stop, or the turn ending, while the changes were captured.
          const threadNow = yield* deps.readThread(scope.threadId);
          const refusalNow =
            threadNow === undefined
              ? { outcome: "refused" as const, detail: "This thread is gone." }
              : agentInviteRefusal(threadNow, { ...rules, startsNow: modeNow === "auto" });
          if (refusalNow !== null) {
            return {
              outcome: refusalNow.outcome,
              detail: refusalNow.detail,
            } satisfies RoomInviteResult;
          }
          const providerNow = (yield* deps.providers).find(
            (entry) => entry.instanceId === target.provider.instanceId,
          );
          if (
            providerNow === undefined ||
            !inviteCandidates([providerNow]).some((candidate) => candidate.key === target.key)
          ) {
            return refused(
              `${target.name} is not available any more: its provider is off or signed out.`,
            ) satisfies RoomInviteResult;
          }
          // The same model invited before comes back as that guest, under its
          // name. A new one is named the way the chat names it: the model,
          // numbered after every agent this thread ever had.
          const earlierGuest = room.thread.participants.find(
            (participant) =>
              participant.guest === true &&
              sameModel(participant.modelSelection, target.modelSelection),
          );
          const handle =
            earlierGuest?.handle ??
            nextRoomAgentName(
              target.name,
              room.entries.map((entry) => entry.modelName),
            );
          const requestId = RoomAgentRequestId.make(randomUUID());
          const agent = { key: target.key, name: handle };
          const rejected = yield* deps.engine
            .dispatch({
              type: "thread.agent-request.submit",
              commandId: CommandId.make(`server:room-invite:${requestId}`),
              threadId: scope.threadId,
              requestId,
              kind: "invite",
              from: rules.from,
              to: { participantId: earlierGuest?.id ?? ThreadParticipantId.make(randomUUID()) },
              callerTurnId,
              chainEpoch,
              message: { messageId: MessageId.make(randomUUID()), text },
              sideTurnId: SideTurnId.make(randomUUID()),
              reviewInput: captured.success,
              invite: {
                guest: { handle, modelSelection: target.modelSelection },
                reason,
                suggestion,
                billing: inviteBilling(providerNow),
                ...(modeNow === "auto" ? { autoChoice: suggestion } : {}),
              },
              createdAt: yield* nowIso,
            })
            .pipe(
              Effect.as(undefined),
              Effect.catch((error) => Effect.succeed(dispatchDetail(error))),
            );
          if (rejected !== undefined) {
            return { outcome: "failed", detail: rejected, agent } satisfies RoomInviteResult;
          }
          return {
            outcome: modeNow === "auto" ? "started" : "asked_user",
            detail:
              modeNow === "auto"
                ? `${handle} is reviewing${suggestion === "teammate" ? " and joined the thread" : ""}. Its review comes back to you as a message.`
                : "The user will decide. If they agree, the review comes back to you as a message; if not, you will not hear back. Do not ask again unless the user asks you to.",
            agent,
            requestId,
          } satisfies RoomInviteResult;
        }),
      );
    });

  return {
    room_agents: roomAgents,
    room_history: roomHistory,
    room_diff: roomDiff,
    room_ask: (
      scope: McpInvocationScope,
      input: { readonly agent: string; readonly question: string },
    ) => answerRequest({ scope, kind: "ask", agent: input.agent, text: input.question }),
    room_review: (
      scope: McpInvocationScope,
      input: {
        readonly agent: string;
        readonly request: string;
        readonly basis?: RoomReviewBasisRequest | undefined;
      },
    ) =>
      answerRequest({
        scope,
        kind: "review",
        agent: input.agent,
        text: input.request,
        basis: input.basis,
      }),
    room_hand_off: roomHandOff,
    room_available_agents: roomAvailableAgents,
    room_invite: roomInvite,
  };
}

export type RoomToolHandlers = ReturnType<typeof makeRoomToolHandlers>;
