/**
 * Child threads in the chat (docs/design/child-threads.md): the threads a
 * thread's agent started, the one that started it, and what the user is
 * asked before any start. The sidebar's family rules live in
 * components/Sidebar.logic.ts; the server's in @threadlines/shared/childThreads.
 */
import type {
  ChildRequestBatchId,
  ChildRequestId,
  EnvironmentId,
  ModelSelection,
  OrchestrationChildRequest,
  OrchestrationChildRequestState,
  RemoteChildThread,
  ThreadId,
  ThreadMessageOrigin,
  TurnId,
} from "@threadlines/contracts";
import { awaitingChildBatch } from "@threadlines/shared/childThreads";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { formatChildThreadCount } from "./components/Sidebar.logic";
import { toSortableTimestamp } from "./lib/threadSort";
import type { ProviderInstanceEntry } from "./providerInstances";
import {
  buildRoomAgentLabels,
  roomAgentDisplayName,
  roomAgentKey,
  roomModelName,
  type RoomThreadLike,
} from "./rooms";
import { selectEnvironmentState, useStore } from "./store";
import type { SidebarThreadSummary } from "./types";

const NO_CHILD_THREADS: readonly SidebarThreadSummary[] = [];

/** Another thread's title, live, for a link to it; null when this device does not know it. */
export function useThreadTitle(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null | undefined,
): string | null {
  return useStore((state) =>
    threadId == null || environmentId === null
      ? null
      : (selectEnvironmentState(state, environmentId).threadShellById[threadId]?.title ?? null),
  );
}

const NO_REMOTE_CHILDREN: readonly RemoteChildThread[] = [];

/** A thread's children on linked computers, from its own record of them. */
export function useRemoteChildren(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): readonly RemoteChildThread[] {
  return useStore((state) =>
    threadId === null
      ? NO_REMOTE_CHILDREN
      : (selectEnvironmentState(state, environmentId).threadShellById[threadId]?.remoteChildren ??
        NO_REMOTE_CHILDREN),
  );
}

/**
 * What a message another thread wrote calls that thread when its title isn't
 * known: the thread that started this one, one this one started, or one it
 * asked for that was never made.
 */
export function unnamedThreadOrigin(origin: Pick<ThreadMessageOrigin, "kind" | "neverMade">) {
  return origin.kind === "request"
    ? "the thread that started it"
    : origin.neverMade === true
      ? "a thread it asked for"
      : "a thread it started";
}

/** Where a message another thread wrote (`fromThread`) came from, for its line. */
export interface ThreadMessageSource {
  /** The computer that thread lives on. */
  readonly environmentId: EnvironmentId;
  /** Its live title, else the one this thread last recorded; null when neither is known. */
  readonly title: string | null;
  /** For a thread on a linked computer, that computer and the name it last carried. */
  readonly computer: { readonly environmentId: EnvironmentId; readonly lastKnown: string } | null;
  /** This app has the thread to open. */
  readonly openable: boolean;
}

/**
 * Names the thread a message came from. One on this computer is named live.
 * One on a linked computer is named live when the app has that computer's
 * threads, else from this thread's own record: the child it started
 * (`remoteChildren`) or the thread that started it (`remoteOrigin`).
 */
export function useThreadMessageSource(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  origin: ThreadMessageOrigin,
): ThreadMessageSource {
  const remoteEnvironmentId = origin.environmentId ?? null;
  const sourceEnvironmentId = remoteEnvironmentId ?? environmentId;
  const liveTitle = useThreadTitle(sourceEnvironmentId, origin.threadId);
  const remoteChildren = useRemoteChildren(
    environmentId,
    remoteEnvironmentId !== null && origin.kind === "report" ? threadId : null,
  );
  const remoteOrigin = useStore((state) =>
    remoteEnvironmentId === null || origin.kind !== "request" || threadId === null
      ? null
      : (selectEnvironmentState(state, environmentId).threadShellById[threadId]?.remoteOrigin ??
        null),
  );
  if (remoteEnvironmentId === null) {
    // A thread that was never made has nothing to open.
    return {
      environmentId,
      title: liveTitle,
      computer: null,
      openable: origin.neverMade !== true,
    };
  }
  const child = remoteChildren.find((candidate) => candidate.threadId === origin.threadId);
  const parent = remoteOrigin?.threadId === origin.threadId ? remoteOrigin : null;
  return {
    environmentId: remoteEnvironmentId,
    title: liveTitle ?? child?.title ?? parent?.threadTitle ?? null,
    computer: {
      environmentId: remoteEnvironmentId,
      lastKnown: child?.label ?? parent?.environmentLabel ?? "",
    },
    openable: liveTitle !== null,
  };
}

/**
 * The threads one turn of a thread started, oldest first, with their live
 * sidebar state: what the parent's chat shows where its agent started them.
 */
export function useChildThreadsStartedIn(
  environmentId: EnvironmentId,
  parentThreadId: ThreadId | null,
  parentTurnId: TurnId | null | undefined,
): readonly SidebarThreadSummary[] {
  const children = useStore(
    useShallow((state) => {
      if (parentThreadId === null || parentTurnId == null) return NO_CHILD_THREADS;
      const environmentState = selectEnvironmentState(state, environmentId);
      const found = environmentState.threadIds.flatMap((threadId) => {
        const summary = environmentState.sidebarThreadSummaryById[threadId];
        return summary !== undefined &&
          summary.parentThreadId === parentThreadId &&
          summary.parentTurnId === parentTurnId
          ? [summary]
          : [];
      });
      return found.length === 0 ? NO_CHILD_THREADS : found;
    }),
  );
  return useMemo(
    () =>
      children.length < 2
        ? children
        : children.toSorted(
            (left, right) =>
              (toSortableTimestamp(left.createdAt) ?? 0) -
                (toSortableTimestamp(right.createdAt) ?? 0) || left.id.localeCompare(right.id),
          ),
    [children],
  );
}

/** A thread's open child requests, from its detail stream; null until it loads. */
export function useChildRequestState(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): OrchestrationChildRequestState | null {
  return useStore((state) =>
    threadId === null
      ? null
      : (selectEnvironmentState(state, environmentId).childRequestsByThreadId[threadId] ?? null),
  );
}

/** One thread an agent asked to start, as the approval card lists it. */
export interface PendingChildThread {
  readonly requestId: ChildRequestId;
  readonly title: string;
  readonly prompt: string;
  readonly modelName: string;
  readonly entry: ProviderInstanceEntry | undefined;
  /** False in a project without git: it shares the project folder. */
  readonly ownWorktree: boolean;
  /** The linked computer it would run on (by its name), or null for this one. */
  readonly computer: string | null;
}

/** Threads an agent asked to start, waiting for the user's yes (ask mode). */
export interface PendingChildThreads {
  readonly batchId: ChildRequestBatchId;
  /** The asking agent's name, the way the rest of the chat names it. */
  readonly fromName: string;
  readonly threads: ReadonlyArray<PendingChildThread>;
}

/** The batch the approval card asks about, or null when none waits. */
export function pendingChildThreads(
  thread: RoomThreadLike & {
    readonly modelSelection: ModelSelection;
    readonly agentRole?: string | undefined;
    readonly childRequests?: OrchestrationChildRequestState | undefined;
  },
  entries: ReadonlyArray<ProviderInstanceEntry>,
  modelDisplayName: (
    model: ProviderInstanceEntry["models"][number],
    entry: ProviderInstanceEntry,
  ) => string,
): PendingChildThreads | null {
  const batch = thread.childRequests ? awaitingChildBatch(thread.childRequests) : [];
  const first = batch[0];
  if (first === undefined) {
    return null;
  }
  const roomLabels = buildRoomAgentLabels(thread, entries, modelDisplayName);
  const fromName =
    roomLabels?.get(roomAgentKey(first.from.participantId))?.name ??
    roomAgentDisplayName(
      roomModelName(thread.modelSelection, entries, modelDisplayName),
      thread.agentRole,
    );
  return {
    batchId: first.batchId,
    fromName,
    threads: batch.flatMap((request) => {
      const launch = request.launch;
      if (launch === undefined) return [];
      return [
        {
          requestId: request.requestId,
          title: launch.title,
          prompt: launch.prompt,
          modelName: roomModelName(launch.modelSelection, entries, modelDisplayName),
          entry: entries.find((entry) => entry.instanceId === launch.modelSelection.instanceId),
          ownWorktree: launch.workspace.kind === "worktree",
          computer: launch.workspace.kind === "remote" ? (launch.target?.label ?? null) : null,
        },
      ];
    }),
  };
}

/** What a `thread_start` call's result said, read from its output when the provider shared it. */
export type ThreadStartOutcome =
  | "started"
  | "asked_user"
  | "off"
  | "limit"
  | "not_allowed"
  | "unavailable_agent"
  | "refused";

const THREAD_START_OUTCOMES: ReadonlySet<string> = new Set<ThreadStartOutcome>([
  "started",
  "asked_user",
  "off",
  "limit",
  "not_allowed",
  "unavailable_agent",
  "refused",
]);

/** The outcome and the thread ids a `thread_start` result names. */
export interface ThreadStartResult {
  readonly outcome: ThreadStartOutcome | null;
  readonly threadIds: ReadonlySet<string>;
  /** The ones it asked of a linked computer (`"workspace":"remote"`). */
  readonly remoteThreadIds: ReadonlySet<string>;
}

/**
 * Reads a `thread_start` call's result (WorkLogEntry.toolResult): its outcome
 * and the ids of the threads it started or asked to start. Read as text, so
 * a result a provider passed along as JSON inside a string reads the same,
 * and one cut short still gives what survived.
 */
export function parseThreadStartResult(output: string | undefined): ThreadStartResult {
  if (!output) {
    return { outcome: null, threadIds: new Set(), remoteThreadIds: new Set() };
  }
  const text = output.replaceAll('\\"', '"');
  const outcomeMatch = /"outcome"\s*:\s*"([a-z_]+)"/u.exec(text);
  const outcome =
    outcomeMatch && THREAD_START_OUTCOMES.has(outcomeMatch[1]!)
      ? (outcomeMatch[1] as ThreadStartOutcome)
      : null;
  const idMatches = [...text.matchAll(/"threadId"\s*:\s*"([^"]+)"/gu)];
  const threadIds = new Set(idMatches.map((match) => match[1]!));
  // Each entry in `threads` leads with its id, so what follows it, up to the
  // next id, is that thread's (a title may hold any character, braces too).
  const remoteThreadIds = new Set(
    idMatches
      .filter((match, index) =>
        /"workspace"\s*:\s*"remote"/u.test(text.slice(match.index, idMatches[index + 1]?.index)),
      )
      .map((match) => match[1]!),
  );
  return { outcome, threadIds, remoteThreadIds };
}

/** Why a start the agent asked for did not happen, in the user's words. */
const THREAD_START_REFUSAL_WORDS: Readonly<
  Record<Exclude<ThreadStartOutcome, "started" | "asked_user">, string>
> = {
  off: "turned off in Settings",
  limit: "over the limit for one message",
  not_allowed: "not allowed from this thread",
  unavailable_agent: "that agent isn't available",
  refused: "refused",
};

const refusalWords = (outcome: ThreadStartOutcome | null): string | null =>
  outcome === null || outcome === "started" || outcome === "asked_user"
    ? null
    : THREAD_START_REFUSAL_WORDS[outcome];

/** One `thread_start` call in the chat. */
export interface ThreadStartCall {
  /** The work-log entry it came from. */
  readonly id: string;
  readonly turnId: TurnId | null;
  readonly result: ThreadStartResult;
}

/**
 * Whether each call in a turn can speak for its own threads: every call that
 * could have started threads named them in its result.
 */
function turnCallsNameTheirThreads(turnCalls: ReadonlyArray<ThreadStartCall>): boolean {
  return turnCalls
    .filter((candidate) => refusalWords(candidate.result.outcome) === null)
    .every((candidate) => candidate.result.threadIds.size > 0);
}

/**
 * Whether a call leaves a record of its own. When the turn's calls do not say
 * which threads are whose, only the turn's last call that could have started
 * threads does (see describeThreadStartCall); refused calls always do.
 */
export function threadStartCallHasRecord(
  call: ThreadStartCall,
  turnCalls: ReadonlyArray<ThreadStartCall>,
): boolean {
  if (refusalWords(call.result.outcome) !== null || turnCallsNameTheirThreads(turnCalls)) {
    return true;
  }
  const creatingCalls = turnCalls.filter(
    (candidate) => refusalWords(candidate.result.outcome) === null,
  );
  return (creatingCalls.at(-1)?.id ?? call.id) === call.id;
}

/** What a `thread_start` call's line in the chat says, and the threads under it. */
export interface StartedThreadsRecord {
  readonly heading: string;
  readonly outcome: string | null;
  readonly threads: readonly SidebarThreadSummary[];
  /** The ones it started on linked computers, from the parent's own record. */
  readonly remoteThreads: readonly RemoteChildThread[];
}

/** How far a start asked of a linked computer got, before it has a thread there. */
function remoteStartWords(request: OrchestrationChildRequest, computer: string): string {
  switch (request.remote?.status) {
    case "awaiting_approval":
      return `waiting for ${computer} to allow it`;
    case "accepted":
      return `starting on ${computer}`;
    default:
      return `sending to ${computer}`;
  }
}

/**
 * The record a `thread_start` call leaves in the parent's chat.
 *
 * Each call speaks for its own threads when every call in its turn named
 * them in its result: its children and its batch waiting for the user are
 * the ones with those ids. When a call did not (the provider kept no
 * result), the turn gets one record, on its last call that could have
 * started threads, covering everything that turn started and every batch it
 * asked about; the turn's other calls return null rather than count another
 * call's threads. A refused call only ever says it was refused.
 *
 * A thread asked of a linked computer has no thread here: it counts as
 * started once the parent records it as a remote child, and until then its
 * request says how far it got ("waiting for Mac mini to allow it").
 */
export function describeThreadStartCall(input: {
  readonly call: ThreadStartCall;
  /** Every `thread_start` call of the same turn, in order, this one included. */
  readonly turnCalls: ReadonlyArray<ThreadStartCall>;
  /** The threads the turn started (`parentTurnId`), live. */
  readonly startedInTurn: ReadonlyArray<SidebarThreadSummary>;
  /** The parent's open child requests. */
  readonly openRequests: ReadonlyArray<OrchestrationChildRequest>;
  /** The parent's children on linked computers. */
  readonly remoteChildren: ReadonlyArray<RemoteChildThread>;
  /** Names a linked computer the way this app knows it (useComputerLabel). */
  readonly computerLabel: (environmentId: EnvironmentId, lastKnown: string) => string;
}): StartedThreadsRecord | null {
  const { call } = input;
  const refusal = refusalWords(call.result.outcome);
  if (refusal !== null) {
    return { heading: "Tried to start threads", outcome: refusal, threads: [], remoteThreads: [] };
  }
  const startsInTurn = input.openRequests.filter(
    (request) => request.kind === "start" && request.callerTurnId === call.turnId,
  );
  if (!threadStartCallHasRecord(call, input.turnCalls)) {
    return null;
  }
  const ownIds = call.result.threadIds;
  const attributable = turnCallsNameTheirThreads(input.turnCalls);
  const isOwn = (threadId: string) => !attributable || ownIds.has(threadId);
  const threads = input.startedInTurn.filter((thread) => isOwn(thread.id));
  const ownStarts = startsInTurn.filter((request) => isOwn(request.childThreadId));
  // A remote child records no turn: a call claims one it named, and the
  // turn's record (no call can say which are whose) one any call of the turn
  // named or whose start request is still open.
  const namedInTurn = attributable
    ? ownIds
    : new Set(input.turnCalls.flatMap((candidate) => [...candidate.result.threadIds]));
  const remoteThreads = input.remoteChildren.filter(
    (child) =>
      namedInTurn.has(child.threadId) ||
      (!attributable && ownStarts.some((request) => request.childThreadId === child.threadId)),
  );
  const waitingHere = ownStarts.filter((request) => request.status === "awaiting_user").length;
  const waitingThere = ownStarts.filter(
    (request) =>
      request.status !== "awaiting_user" &&
      request.remote !== undefined &&
      !remoteThreads.some((child) => child.threadId === request.childThreadId),
  );
  const asked = attributable
    ? call.result.outcome === "asked_user"
    : input.turnCalls.some((candidate) => candidate.result.outcome === "asked_user");
  // Started without asking: every thread it named here was started, even one
  // that is not here yet (still being set up) or was deleted since. One named
  // on a linked computer counts once that computer took it.
  const localIds = [...ownIds].filter((id) => !call.result.remoteThreadIds.has(id));
  const startedCount =
    (attributable && call.result.outcome === "started"
      ? Math.max(localIds.length, threads.length)
      : threads.length) + remoteThreads.length;
  const started = formatChildThreadCount(startedCount);
  const record = (heading: string, outcome: string | null): StartedThreadsRecord => ({
    heading,
    outcome,
    threads,
    remoteThreads,
  });
  if (waitingHere > 0) {
    return startedCount === 0
      ? record(`Asked to start ${formatChildThreadCount(waitingHere)}`, "waiting for you")
      : record(`Started ${started}`, `${waitingHere} more waiting for you`);
  }
  if (waitingThere.length > 0) {
    const phrases = new Set(
      waitingThere.map((request) =>
        remoteStartWords(
          request,
          input.computerLabel(request.remote!.environmentId, request.remote!.label),
        ),
      ),
    );
    const phrase = phrases.size === 1 ? [...phrases][0]! : "waiting for other computers";
    return startedCount === 0
      ? record(`Asked to start ${formatChildThreadCount(waitingThere.length)}`, phrase)
      : record(`Started ${started}`, `${waitingThere.length} more ${phrase}`);
  }
  if (startedCount > 0) {
    return record(`Started ${started}`, asked ? "you said start" : null);
  }
  // Nothing open and nothing started. When no call said which threads were
  // asked for, a child on a linked computer may be this turn's all the same.
  if (!attributable && input.remoteChildren.length > 0) {
    return record(asked ? "Asked to start threads" : "Tried to start threads", null);
  }
  if (asked) {
    return record("Asked to start threads", "not started");
  }
  // Started here without asking, but every thread it named was one a linked
  // computer was to start, and none did: its user said no, or the start was
  // dropped before it got there.
  if (
    attributable &&
    call.result.outcome === "started" &&
    localIds.length === 0 &&
    call.result.remoteThreadIds.size > 0
  ) {
    return record("Tried to start threads", "not started");
  }
  if (call.result.outcome === "started") {
    return record("Started threads", null);
  }
  // Nothing says what came of it.
  return record("Tried to start threads", null);
}
