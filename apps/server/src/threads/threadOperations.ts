/**
 * The work on threads that every caller from outside a thread shares: the
 * thread tools Threadlines' own agents have (mcp/threadToolHandlers.ts), a
 * linked computer (links/LinkRequests.ts) and outside agents
 * (outsideAgents/connectToolHandlers.ts). Each caller keeps its own rules
 * (who may read, start, send or stop what); this is what they do once
 * allowed.
 *
 * - How a thread is doing: `threadStatus`, read once (`readThreadStatus`) or
 *   followed (`watchThreadStatus`) over every source it combines.
 * - Listing and reading: `summarizeThread`, `listThreadAgents`,
 *   `readThreadPage`.
 * - Starting and sending: `requestedAgent` (an agent named in a call) and
 *   `dispatchOutcome` (a refused or failed dispatch, as a tool outcome).
 */
import type {
  AgentThreadAgent,
  OutsideAgentConnectionId,
  OrchestrationEvent,
  OrchestrationThread,
  OrchestrationThreadShell,
  ModelSelection,
  PeerAgent,
  ProviderInteractionMode,
  ProviderOptionSelection,
  ServerProvider,
  ThreadId,
} from "@threadlines/contracts";
import { ProviderInstanceId } from "@threadlines/contracts";
import { messageAuthor, outsideAgentAuthor } from "@threadlines/shared/messageAuthor";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { inviteBilling } from "../orchestration/agentInvites.ts";
import {
  childAgentProviderName,
  childAgentRefusal,
  childModelRefusal,
  modelReasoningSetting,
} from "../orchestration/childThreadAgents.ts";
import { coalesceLatestAggregateEvents } from "../orchestration/shellStreamCoalescing.ts";
import { roomAgentEntries, roomAgentName } from "../mcp/roomAgents.ts";
import type {
  ThreadAgentsResult,
  ThreadReadResult,
  ThreadStatusWord,
  ThreadSummary,
} from "../mcp/threadTools.ts";

/** A thread's title, at most this long; a longer one is cut. */
export const THREAD_TITLE_CHAR_LIMIT = 80;
/** A prompt or message to a thread, at most this long. */
export const THREAD_PROMPT_CHAR_LIMIT = 50_000;
/** What a read returns of one message. */
export const THREAD_READ_MESSAGE_CHAR_LIMIT = 4_000;
const THREAD_READ_DEFAULT_LIMIT = 20;
const THREAD_READ_MAX_LIMIT = 50;
/** How many models an agent list shows per provider before "and N more". */
const MODELS_LISTED_PER_PROVIDER = 12;

/** `text` cut at `limit` characters, saying so. */
export const clipText = (text: string, limit: number) =>
  text.length > limit
    ? { text: `${text.slice(0, limit)}\n[clipped; read the rest in the thread]`, clipped: true }
    : { text, clipped: false };

/** A model's name as the model picker shows it. */
export const modelLabel = (selection: ModelSelection, providers: ReadonlyArray<ServerProvider>) => {
  const model = providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((candidate) => candidate.slug === selection.model);
  return model?.shortName ?? model?.name ?? selection.model;
};

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** What a thread waits on the user for: an approval, a question, or its plan. */
export type ThreadWaitingOn = "approval" | "question" | "plan";

export interface ThreadStatus {
  readonly word: ThreadStatusWord;
  /** Set exactly when `word` is `needs the user`. */
  readonly waitingOn: ThreadWaitingOn | null;
}

const needsTheUser = (waitingOn: ThreadWaitingOn): ThreadStatus => ({
  word: "needs the user",
  waitingOn,
});
const statusOf = (word: Exclude<ThreadStatusWord, "needs the user">): ThreadStatus => ({
  word,
  waitingOn: null,
});

/**
 * How a thread is doing, in the words the sidebar uses: blocked on the user
 * first (an approval, including a card asking about its agent's
 * scheduled-task change, then a question), then running, then waiting on
 * background or child work, then how its last turn ended. `wrapped` is only
 * the user's explicit Mark done; a plan its last turn left for the user to
 * act on comes after it (the user who filed the thread has decided). The
 * sidebar's automatic filing rules live in the client.
 */
export function threadStatus(
  thread: OrchestrationThreadShell,
  /** A card in it asks the user about its agent's scheduled-task change. */
  scheduleAnswerWaiting = false,
): ThreadStatus {
  if (thread.hasPendingApprovals || thread.pendingChildApproval || scheduleAnswerWaiting) {
    return needsTheUser("approval");
  }
  if (thread.hasPendingUserInput) {
    return needsTheUser("question");
  }
  const session = thread.session;
  if (
    thread.latestTurn?.state === "running" ||
    (session !== null &&
      (session.activeTurnId !== null ||
        session.status === "running" ||
        session.status === "starting"))
  ) {
    return statusOf("working");
  }
  const awaitedTasks = session?.awaitedBackgroundTaskCount ?? session?.pendingBackgroundTaskCount;
  if ((awaitedTasks ?? 0) > 0 || thread.awaitedChildThreadCount > 0) {
    return statusOf("waiting");
  }
  if (thread.latestTurn?.state === "error" || session?.status === "error") {
    return statusOf("failed");
  }
  if (thread.doneOverride?.state === "done") {
    return statusOf("wrapped");
  }
  if (thread.hasActionableProposedPlan) {
    return needsTheUser("plan");
  }
  return statusOf("idle");
}

/** The thread's newest turn and how it ended (`running` while it hasn't); null before its first. */
export const threadLastTurn = (thread: Pick<OrchestrationThreadShell, "latestTurn">) =>
  thread.latestTurn === null
    ? null
    : { turnId: thread.latestTurn.turnId, state: thread.latestTurn.state };

/**
 * Everything `threadStatus` combines, where it comes from: the thread's
 * sidebar summary (moved by its domain events) and the scheduled-task cards
 * waiting for the user (moved by the scheduled tasks' own changes).
 */
export interface ThreadStatusFeed {
  /** The domain-event feed, subscribed when this runs (OrchestrationEngine.subscribeDomainEvents). */
  readonly subscribeEvents: Effect.Effect<Stream.Stream<OrchestrationEvent>, never, Scope.Scope>;
  /** The thread's sidebar summary; undefined once archived or deleted. */
  readonly readShell: (threadId: ThreadId) => Effect.Effect<OrchestrationThreadShell | undefined>;
  /** Threads a scheduled-task card waits in (ScheduledTasks.waitingThreadIds). */
  readonly scheduleAnswerWaiting: Effect.Effect<ReadonlySet<ThreadId>>;
  /**
   * Emits whenever those cards may have changed, starting with one emission
   * once it is listening (ScheduledTasks.changes); empty without scheduled tasks.
   */
  readonly scheduleAnswerChanges: Stream.Stream<unknown>;
}

export interface ThreadStatusReading {
  /** Undefined: the thread is archived, deleted or never existed. */
  readonly shell: OrchestrationThreadShell | undefined;
  readonly scheduleAnswerWaiting: boolean;
  /** Null exactly when `shell` is undefined. */
  readonly status: ThreadStatus | null;
}

/** A thread's status now, from every source it combines. */
export const readThreadStatus = (
  feed: Pick<ThreadStatusFeed, "readShell" | "scheduleAnswerWaiting">,
  threadId: ThreadId,
): Effect.Effect<ThreadStatusReading> =>
  Effect.gen(function* () {
    const [shell, waiting] = yield* Effect.all([
      feed.readShell(threadId),
      feed.scheduleAnswerWaiting,
    ]);
    const scheduleAnswerWaiting = waiting.has(threadId);
    return {
      shell,
      scheduleAnswerWaiting,
      status: shell === undefined ? null : threadStatus(shell, scheduleAnswerWaiting),
    };
  });

/**
 * A thread's status now, then again whenever a source it combines may have
 * moved. The event feed is subscribed before the first read, so no change
 * can fall between the two; the scheduled tasks' feed reads afresh on its
 * first emission, so a card that appeared before it was listening still
 * counts. Readings repeat; callers filter for what they wait on.
 */
export const watchThreadStatus = (
  feed: ThreadStatusFeed,
  threadId: ThreadId,
): Stream.Stream<ThreadStatusReading> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const events = yield* feed.subscribeEvents;
      const first = yield* readThreadStatus(feed, threadId);
      const moved = Stream.merge(
        coalesceLatestAggregateEvents(
          events.pipe(
            Stream.filter(
              (event) => event.aggregateKind === "thread" && event.aggregateId === threadId,
            ),
          ),
        ),
        feed.scheduleAnswerChanges,
      );
      return Stream.concat(
        Stream.make(first),
        moved.pipe(Stream.mapEffect(() => readThreadStatus(feed, threadId))),
      );
    }),
  );

// ---------------------------------------------------------------------------
// Listing and reading
// ---------------------------------------------------------------------------

/**
 * One thread as the list tools report it. `caller` is the asking thread here,
 * or `outsideCaller` the asking outside agent's connection; neither when
 * another computer reads it (peer.thread.read), where a thread its link
 * started is "started by" that computer's thread.
 */
export const summarizeThread = (
  thread: OrchestrationThreadShell,
  input: {
    readonly caller?: Pick<OrchestrationThread, "id">;
    readonly outsideCaller?: OutsideAgentConnectionId;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly titleOf: (threadId: ThreadId) => string | undefined;
    /** Threads a scheduled-task card waits in (ScheduledTasks.waitingThreadIds). */
    readonly scheduleAnswerWaiting?: ReadonlySet<ThreadId>;
  },
): ThreadSummary => {
  const remoteOrigin = thread.remoteOrigin ?? null;
  const outsideOrigin = thread.outsideOrigin ?? null;
  return {
    threadId: thread.id,
    title: thread.title,
    status: threadStatus(thread, input.scheduleAnswerWaiting?.has(thread.id) ?? false).word,
    branch: thread.branch,
    model: modelLabel(thread.modelSelection, input.providers),
    attached: (thread.parentThreadId !== null && thread.attachedToParent) || remoteOrigin !== null,
    startedBy:
      remoteOrigin !== null
        ? `${remoteOrigin.threadTitle} (on ${remoteOrigin.environmentLabel})`
        : outsideOrigin !== null
          ? outsideOrigin.connectionId === input.outsideCaller
            ? "you"
            : outsideAgentAuthor(outsideOrigin)
          : thread.parentThreadId === null
            ? null
            : thread.parentThreadId === input.caller?.id
              ? "you"
              : (input.titleOf(thread.parentThreadId) ?? thread.parentThreadId),
    ...(input.caller !== undefined && thread.id === input.caller.id ? { you: true } : {}),
  };
};

/**
 * Titles a read of `target` names threads by: the threads its cross-thread
 * messages came from, and its parent. `known` are titles already at hand.
 */
export const relatedThreadTitles = (
  target: Pick<OrchestrationThread, "messages" | "parentThreadId">,
  readShell: (threadId: ThreadId) => Effect.Effect<OrchestrationThreadShell | undefined>,
  known: ReadonlyMap<string, string> = new Map(),
): Effect.Effect<Map<string, string>> =>
  Effect.gen(function* () {
    const related = new Set<ThreadId>();
    for (const message of target.messages) {
      if (message.fromThread !== undefined) related.add(message.fromThread.threadId);
    }
    if (target.parentThreadId !== null) related.add(target.parentThreadId);
    const titles = new Map(known);
    yield* Effect.forEach(
      [...related].filter((threadId) => !titles.has(threadId)),
      (threadId) =>
        readShell(threadId).pipe(
          Effect.tap((shell) =>
            Effect.sync(() => {
              if (shell !== undefined) titles.set(threadId, shell.title);
            }),
          ),
        ),
      { discard: true },
    );
    return titles;
  });

/**
 * The agents a thread here can run on, as thread_agents and a linked
 * computer's peer.describe list them: ready providers that can honor the
 * caller's interaction mode, and the set-up ones that can't take a thread now.
 * An agent is shown to a caller through `agentForCaller`.
 */
export function listThreadAgents(
  providers: ReadonlyArray<ServerProvider>,
  input: {
    readonly interactionMode: ProviderInteractionMode;
    /** List only this provider, with every model. */
    readonly only?: string | undefined;
  },
): {
  readonly agents: Array<PeerAgent>;
  readonly unavailable: Array<ThreadAgentsResult["unavailable"][number]>;
} {
  const agents: Array<PeerAgent> = [];
  const unavailable: Array<ThreadAgentsResult["unavailable"][number]> = [];
  for (const provider of providers) {
    // Providers the user never turned on are not worth a line.
    if (!provider.enabled || !provider.installed) continue;
    if (input.only !== undefined && provider.instanceId !== input.only) continue;
    const refusal = childAgentRefusal(provider, input.interactionMode);
    const name = childAgentProviderName(provider);
    if (refusal !== null) {
      unavailable.push({ instanceId: provider.instanceId, name, reason: refusal });
      continue;
    }
    const models = provider.models
      .filter((model) => model.isHidden !== true)
      .map((model) => {
        const reasoningSetting = modelReasoningSetting(model.capabilities);
        return {
          model: model.slug,
          name: model.shortName ?? model.name,
          ...(reasoningSetting !== null ? { reasoningSetting } : {}),
        };
      });
    // A gateway can list a hundred models; the first ones, in the
    // provider's own order, are enough to choose from unless asked.
    const listed = input.only === undefined ? models.slice(0, MODELS_LISTED_PER_PROVIDER) : models;
    agents.push({
      instanceId: provider.instanceId,
      name,
      billing: inviteBilling(provider).label,
      models: listed,
      ...(listed.length < models.length ? { moreModels: models.length - listed.length } : {}),
      driver: provider.driver,
    });
  }
  return { agents, unavailable };
}

/** A listed agent as a calling agent reads it: its models' reasoning as level ids. */
export const agentForCaller = ({
  driver: _driver,
  models,
  ...agent
}: PeerAgent): AgentThreadAgent => ({
  ...agent,
  models: models.map(({ reasoningSetting, ...model }) => ({
    ...model,
    ...(reasoningSetting !== undefined
      ? { reasoning: reasoningSetting.levels.map((level) => level.id) }
      : {}),
  })),
});

/**
 * A page of a thread's messages, oldest first, as thread_read returns it
 * here and peer.thread.read returns it to a linked computer.
 */
export function readThreadPage(
  target: OrchestrationThread,
  input: {
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly titles: ReadonlyMap<string, string>;
    readonly after?: number | undefined;
    readonly limit?: number | undefined;
  },
): Pick<ThreadReadResult, "messages" | "next" | "more"> {
  const entries = roomAgentEntries(target, modelLabel(target.modelSelection, input.providers));
  const remoteOrigin = target.remoteOrigin ?? null;
  const names = {
    agentName: (participantId: Parameters<typeof roomAgentName>[1]) =>
      roomAgentName(entries, participantId),
    threadTitle: (threadId: ThreadId) =>
      input.titles.get(threadId) ??
      (remoteOrigin !== null && remoteOrigin.threadId === threadId
        ? remoteOrigin.threadTitle
        : undefined),
  };
  const sequenceOf = (message: OrchestrationThread["messages"][number]) =>
    message.eventSequence ?? 0;
  const readable = target.messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") && message.text.trim().length > 0,
    )
    .toSorted(
      (left, right) =>
        sequenceOf(left) - sequenceOf(right) || left.createdAt.localeCompare(right.createdAt),
    );
  const limit = Math.max(
    1,
    Math.min(
      THREAD_READ_MAX_LIMIT,
      Math.floor(
        input.limit !== undefined && Number.isFinite(input.limit)
          ? input.limit
          : THREAD_READ_DEFAULT_LIMIT,
      ),
    ),
  );
  const after = input.after !== undefined && Number.isFinite(input.after) ? input.after : undefined;
  const newer =
    after !== undefined ? readable.filter((message) => sequenceOf(message) > after) : readable;
  const page = after !== undefined ? newer.slice(0, limit) : newer.slice(-limit);
  const last = page.at(-1);
  return {
    messages: page.map((message) => {
      const { author, origin } = messageAuthor(message, names);
      const clipped = clipText(message.text.trim(), THREAD_READ_MESSAGE_CHAR_LIMIT);
      return {
        messageId: message.id,
        sequence: sequenceOf(message),
        at: message.createdAt,
        role: message.role === "user" ? ("user" as const) : ("assistant" as const),
        author,
        origin,
        text: clipped.text,
        ...(clipped.clipped ? { clipped: true } : {}),
        ...(message.streaming ? { streaming: true } : {}),
      };
    }),
    next: last !== undefined ? sequenceOf(last) : (after ?? null),
    more: after !== undefined && newer.length > page.length,
  };
}

// ---------------------------------------------------------------------------
// Starting and sending
// ---------------------------------------------------------------------------

/** An agent named in a call: a provider instance and a model, with options. */
export interface RequestedAgent {
  readonly instanceId: string;
  readonly model: string;
  readonly options?:
    | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    | undefined;
}

/**
 * An agent a call named, trimmed and with unusable options dropped, or why
 * it can't be used. `listTool` is the tool that lists the agents to pick from.
 */
export const requestedAgent = (
  agent: RequestedAgent,
  listTool: string,
): ModelSelection | { readonly refused: string } => {
  const instanceId = agent.instanceId.trim();
  const model = agent.model.trim();
  if (instanceId.length === 0 || model.length === 0) {
    return { refused: `Name the agent's instanceId and model, from ${listTool}.` };
  }
  const options = (agent.options ?? []).flatMap((option): ProviderOptionSelection[] => {
    const id = option.id.trim();
    const value = typeof option.value === "string" ? option.value.trim() : option.value;
    return id.length > 0 && value !== "" ? [{ id, value }] : [];
  });
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    model,
    ...(options.length > 0 ? { options } : {}),
  };
};

/**
 * The agent a new thread runs on when a caller names none, as the composer
 * would pick it: the user's default for new threads (Settings), else the
 * project's own default, else the first agent ready to take a thread. Each
 * must be able to take one now (childModelRefusal). Null when none can.
 */
export function defaultThreadAgent(
  providers: ReadonlyArray<ServerProvider>,
  input: {
    readonly userDefault: ModelSelection | null;
    readonly projectDefault: ModelSelection | null;
    readonly interactionMode: ProviderInteractionMode;
  },
): ModelSelection | null {
  for (const candidate of [input.userDefault, input.projectDefault]) {
    if (
      candidate !== null &&
      childModelRefusal({
        selection: candidate,
        providers,
        interactionMode: input.interactionMode,
        knownModel: true,
      }) === null
    ) {
      return candidate;
    }
  }
  const first = listThreadAgents(providers, { interactionMode: input.interactionMode }).agents[0];
  const model = first?.models[0]?.model;
  return first !== undefined && model !== undefined
    ? { instanceId: ProviderInstanceId.make(first.instanceId), model }
    : null;
}

/** The decider's own words for a refused command, or `failed` for anything else. */
export const dispatchOutcome = (error: {
  readonly _tag: string;
  readonly message: string;
}): { readonly outcome: "refused" | "failed"; readonly detail: string } => {
  const detail =
    "detail" in error && typeof error.detail === "string" && error.detail.trim() !== ""
      ? error.detail
      : error.message;
  return error._tag === "OrchestrationCommandInvariantError" ||
    error._tag === "OrchestrationCommandPreviouslyRejectedError"
    ? { outcome: "refused", detail }
    : { outcome: "failed", detail: `It could not be recorded: ${detail}` };
};
