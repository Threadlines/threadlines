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
const THREAD_READ_MESSAGE_CHAR_LIMIT = 4_000;
/** What a read of one message by its id (`messageId`) returns of it at a time. */
export const THREAD_READ_PART_CHAR_LIMIT = 20_000;
const THREAD_READ_DEFAULT_LIMIT = 20;
const THREAD_READ_MAX_LIMIT = 50;
/** How many models an agent list shows per provider before "and N more". */
const MODELS_LISTED_PER_PROVIDER = 12;

/** A read by `messageId` that names no message in the thread. */
export const READ_MESSAGE_NOT_FOUND =
  "This thread has no message with that messageId. Read the thread without one to list its messages.";

/** Where to cut `text` at `at` or just before, so a character outside the BMP stays whole. */
const cutAt = (text: string, at: number) => {
  const code = text.charCodeAt(at - 1);
  return at > 0 && at < text.length && code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
};

/**
 * A message's text as a read returns it: the first THREAD_READ_MESSAGE_CHAR_LIMIT
 * characters, and when that cut it, how long it is and how to read the rest
 * (thread_read with its `messageId`).
 */
export const clipMessageText = (text: string) => {
  if (text.length <= THREAD_READ_MESSAGE_CHAR_LIMIT) return { text, clipped: false } as const;
  const end = cutAt(text, THREAD_READ_MESSAGE_CHAR_LIMIT);
  return {
    text: `${text.slice(0, end)}\n[clipped: the first ${end.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters. thread_read with this messageId reads the rest.]`,
    clipped: true,
    length: text.length,
  } as const;
};

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
 * scheduled-task or settings change, then a question that pauses the agent),
 * then running, then a question it asked while working, then waiting on
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
  if (
    thread.hasPendingApprovals ||
    thread.pendingChildApproval ||
    thread.pendingSettingsChange ||
    scheduleAnswerWaiting
  ) {
    return needsTheUser("approval");
  }
  // A question that pauses the agent needs the user now; one it asked in
  // passing, while it keeps working, needs them once the work stops.
  if (thread.hasBlockingUserInput ?? thread.hasPendingUserInput) {
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
  // Like the sidebar, an agent answering on the side is still work going on.
  if (thread.hasPendingUserInput && (thread.sideTurn ?? null) === null) {
    return needsTheUser("question");
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
 * here and peer.thread.read returns it to a linked computer. Each message is
 * clipped (clipMessageText). With `messageId`, the page is that one message,
 * from `offset` (default 0), THREAD_READ_PART_CHAR_LIMIT characters at a
 * time with `nextOffset` while more follows; `missing` when the thread has
 * no such message to read.
 */
export function readThreadPage(
  target: OrchestrationThread,
  input: {
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly titles: ReadonlyMap<string, string>;
    readonly after?: number | undefined;
    readonly limit?: number | undefined;
    readonly messageId?: string | undefined;
    readonly offset?: number | undefined;
    /**
     * What a reader is shown of each message's text, applied to the whole text
     * before it is clipped or cut into parts (the assistants door scrubs the
     * home folder), so offsets and lengths are of what it reads.
     */
    readonly shownText?: ((text: string) => string) | undefined;
  },
): Pick<ThreadReadResult, "messages" | "next" | "more"> & { readonly missing?: true } {
  const shown = (text: string) =>
    input.shownText === undefined ? text.trim() : input.shownText(text.trim());
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
  const entryOf = (message: (typeof readable)[number], text: ThreadReadMessageText) => {
    const { author, origin } = messageAuthor(message, names);
    return {
      messageId: message.id,
      sequence: sequenceOf(message),
      at: message.createdAt,
      role: message.role === "user" ? ("user" as const) : ("assistant" as const),
      author,
      origin,
      ...text,
      ...(message.streaming ? { streaming: true } : {}),
    };
  };
  const wanted = input.messageId?.trim();
  if (wanted !== undefined && wanted.length > 0) {
    const index = readable.findIndex((message) => message.id === wanted);
    const message = readable[index];
    if (message === undefined) return { messages: [], next: null, more: false, missing: true };
    return {
      messages: [entryOf(message, messagePart(shown(message.text), input.offset))],
      next: sequenceOf(message),
      more: index < readable.length - 1,
    };
  }
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
      const clipped = clipMessageText(shown(message.text));
      return entryOf(message, {
        text: clipped.text,
        ...(clipped.clipped ? { clipped: true, length: clipped.length } : {}),
      });
    }),
    next: last !== undefined ? sequenceOf(last) : (after ?? null),
    more: after !== undefined && newer.length > page.length,
  };
}

/** A read message's text and, when that's only part of it, where the part sits. */
interface ThreadReadMessageText {
  readonly text: string;
  readonly clipped?: true;
  readonly length?: number;
  readonly offset?: number;
  readonly nextOffset?: number;
}

/** `text` from `offset`, THREAD_READ_PART_CHAR_LIMIT characters at most. */
function messagePart(text: string, rawOffset: number | undefined): ThreadReadMessageText {
  const offset =
    rawOffset !== undefined && Number.isFinite(rawOffset)
      ? Math.min(text.length, Math.max(0, Math.floor(rawOffset)))
      : 0;
  if (offset === 0 && text.length <= THREAD_READ_PART_CHAR_LIMIT) return { text };
  const end = cutAt(text, Math.min(text.length, offset + THREAD_READ_PART_CHAR_LIMIT));
  // A cut that would leave nothing (one wide character right at the limit) takes it whole.
  const stop = end > offset ? end : Math.min(text.length, offset + 2);
  return {
    text: text.slice(offset, stop),
    clipped: true,
    length: text.length,
    offset,
    ...(stop < text.length ? { nextOffset: stop } : {}),
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
