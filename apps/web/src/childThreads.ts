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
  ThreadId,
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
}

/**
 * Reads a `thread_start` call's result (WorkLogEntry.toolResult): its outcome
 * and the ids of the threads it started or asked to start. Read as text, so
 * a result a provider passed along as JSON inside a string reads the same,
 * and one cut short still gives what survived.
 */
export function parseThreadStartResult(output: string | undefined): ThreadStartResult {
  if (!output) {
    return { outcome: null, threadIds: new Set() };
  }
  const text = output.replaceAll('\\"', '"');
  const outcomeMatch = /"outcome"\s*:\s*"([a-z_]+)"/u.exec(text);
  const outcome =
    outcomeMatch && THREAD_START_OUTCOMES.has(outcomeMatch[1]!)
      ? (outcomeMatch[1] as ThreadStartOutcome)
      : null;
  const threadIds = new Set(
    [...text.matchAll(/"threadId"\s*:\s*"([^"]+)"/gu)].map((match) => match[1]!),
  );
  return { outcome, threadIds };
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
 */
export function describeThreadStartCall(input: {
  readonly call: ThreadStartCall;
  /** Every `thread_start` call of the same turn, in order, this one included. */
  readonly turnCalls: ReadonlyArray<ThreadStartCall>;
  /** The threads the turn started (`parentTurnId`), live. */
  readonly startedInTurn: ReadonlyArray<SidebarThreadSummary>;
  /** The parent's open child requests. */
  readonly openRequests: ReadonlyArray<OrchestrationChildRequest>;
}): StartedThreadsRecord | null {
  const { call } = input;
  const refusal = refusalWords(call.result.outcome);
  if (refusal !== null) {
    return { heading: "Tried to start threads", outcome: refusal, threads: [] };
  }
  const waitingInTurn = input.openRequests.filter(
    (request) =>
      request.kind === "start" &&
      request.status === "awaiting_user" &&
      request.callerTurnId === call.turnId,
  );
  if (!threadStartCallHasRecord(call, input.turnCalls)) {
    return null;
  }
  const ownIds = call.result.threadIds;
  const attributable = turnCallsNameTheirThreads(input.turnCalls);
  const threads = attributable
    ? input.startedInTurn.filter((thread) => ownIds.has(thread.id))
    : input.startedInTurn;
  const waiting = attributable
    ? waitingInTurn.filter((request) => ownIds.has(request.childThreadId)).length
    : waitingInTurn.length;
  const asked = attributable
    ? call.result.outcome === "asked_user"
    : input.turnCalls.some((candidate) => candidate.result.outcome === "asked_user");
  // Started without asking: every thread it named was started, even one that
  // is not here yet (still being set up) or was deleted since.
  const startedCount =
    attributable && call.result.outcome === "started"
      ? Math.max(ownIds.size, threads.length)
      : threads.length;
  const started = formatChildThreadCount(startedCount);
  if (waiting > 0) {
    return startedCount === 0
      ? {
          heading: `Asked to start ${formatChildThreadCount(waiting)}`,
          outcome: "waiting for you",
          threads,
        }
      : { heading: `Started ${started}`, outcome: `${waiting} more waiting for you`, threads };
  }
  if (startedCount > 0) {
    return { heading: `Started ${started}`, outcome: asked ? "you said start" : null, threads };
  }
  if (asked) {
    return { heading: "Asked to start threads", outcome: "not started", threads };
  }
  if (call.result.outcome === "started") {
    return { heading: "Started threads", outcome: null, threads };
  }
  // Nothing says what came of it.
  return { heading: "Tried to start threads", outcome: null, threads };
}
