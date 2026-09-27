/**
 * Steps of older turns.
 *
 * The live thread feed carries only the newest `MAX_THREAD_ACTIVITIES`
 * activity rows, so in a long thread the earlier turns arrive with their
 * messages but without their steps. The chat asks the server for those turns
 * one at a time as the reader scrolls back to them. A finished turn never
 * changes, so each is fetched and worked out once, then kept.
 */
import type {
  EnvironmentId,
  OrchestrationThreadActivity,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { MAX_THREAD_ACTIVITIES } from "@threadlines/shared/threadLimits";
import { queryOptions, useQueries } from "@tanstack/react-query";

import { ensureEnvironmentApi } from "~/environmentApi";
import { deriveWorkLogEntries, type WorkLogEntry } from "~/session-logic";

type TurnStepHistory = ReadonlyMap<TurnId, ReadonlyArray<WorkLogEntry>>;

interface TurnSteps {
  readonly turnId: TurnId;
  readonly entries: ReadonlyArray<WorkLogEntry>;
}

const EMPTY_HISTORY: TurnStepHistory = new Map();

/**
 * Finished turns whose steps the live feed may have cut. Nothing is cut until
 * the feed is full; after that, the turn its oldest row belongs to and every
 * turn that replied before that row may be missing steps. The running turn is
 * left to the live feed.
 */
export function turnsWithCutSteps(input: {
  readonly activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "turnId" | "createdAt">>;
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly turnId?: TurnId | null | undefined;
    readonly createdAt: string;
  }>;
  readonly activeTurnId: TurnId | null;
}): ReadonlySet<TurnId> {
  // The feed keeps its newest rows plus a few older pinned ones (open prompts,
  // the latest plan), so the window starts this far from the end.
  const windowStart = input.activities.at(-MAX_THREAD_ACTIVITIES);
  if (input.activities.length < MAX_THREAD_ACTIVITIES || windowStart === undefined) {
    return new Set();
  }
  const cut = new Set<TurnId>();
  if (windowStart.turnId) {
    cut.add(windowStart.turnId);
  }
  for (const message of input.messages) {
    if (
      message.role === "assistant" &&
      message.turnId &&
      message.createdAt <= windowStart.createdAt
    ) {
      cut.add(message.turnId);
    }
  }
  if (input.activeTurnId) {
    cut.delete(input.activeTurnId);
  }
  return cut;
}

export function turnStepsQueryOptions(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}) {
  return queryOptions({
    queryKey: [
      "orchestration",
      "turn-steps",
      input.environmentId,
      input.threadId,
      input.turnId,
    ] as const,
    // Only the worked-out steps are kept: a turn's raw rows can run to tens of
    // megabytes of tool output the steps never show.
    queryFn: async (): Promise<TurnSteps> => {
      const { activities } = await ensureEnvironmentApi(
        input.environmentId,
      ).orchestration.getTurnActivities({ threadId: input.threadId, turnId: input.turnId });
      return { turnId: input.turnId, entries: deriveWorkLogEntries(activities, null) };
    },
    staleTime: Infinity,
    retry: 1,
  });
}

function combineTurnSteps(
  results: ReadonlyArray<{ readonly data?: TurnSteps | undefined }>,
): TurnStepHistory {
  if (!results.some((result) => result.data !== undefined)) {
    return EMPTY_HISTORY;
  }
  const history = new Map<TurnId, ReadonlyArray<WorkLogEntry>>();
  for (const result of results) {
    if (result.data) {
      history.set(result.data.turnId, result.data.entries);
    }
  }
  return history;
}

/** The fetched steps of `turnIds`, by turn; turns still loading are absent. */
export function useTurnStepHistory(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly turnIds: ReadonlyArray<TurnId>;
}): TurnStepHistory {
  const { environmentId, threadId } = input;
  return useQueries({
    queries:
      threadId === null
        ? []
        : input.turnIds.map((turnId) => turnStepsQueryOptions({ environmentId, threadId, turnId })),
    combine: combineTurnSteps,
  });
}

/**
 * The timeline's steps: a fetched turn is told whole from its own rows, and
 * everything else from the live feed.
 */
export function mergeTurnStepHistory(
  live: WorkLogEntry[],
  history: TurnStepHistory,
): WorkLogEntry[] {
  if (history.size === 0) {
    return live;
  }
  return [
    ...[...history.values()].flat(),
    ...live.filter((entry) => !entry.turnId || !history.has(entry.turnId)),
  ];
}
