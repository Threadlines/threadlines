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
  OrchestrationChildRequestState,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { awaitingChildBatch } from "@threadlines/shared/childThreads";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

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
export function parseThreadStartResult(output: string | undefined): {
  readonly outcome: ThreadStartOutcome | null;
  readonly threadIds: ReadonlySet<string>;
} {
  if (!output) {
    return { outcome: null, threadIds: new Set() };
  }
  const outcomeMatch = /"outcome"\s*:\s*"([a-z_]+)"/u.exec(output);
  const outcome =
    outcomeMatch && THREAD_START_OUTCOMES.has(outcomeMatch[1]!)
      ? (outcomeMatch[1] as ThreadStartOutcome)
      : null;
  const threadIds = new Set(
    [...output.matchAll(/"threadId"\s*:\s*"([^"]+)"/gu)].map((match) => match[1]!),
  );
  return { outcome, threadIds };
}

/** Why a start the agent asked for did not happen, in the user's words. */
export const THREAD_START_REFUSAL_WORDS: Readonly<
  Record<Exclude<ThreadStartOutcome, "started" | "asked_user">, string>
> = {
  off: "turned off in Settings",
  limit: "over the limit for one message",
  not_allowed: "not allowed from this thread",
  unavailable_agent: "that agent isn't available",
  refused: "refused",
};
