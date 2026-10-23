/**
 * Scheduled tasks across computers (docs/design/fleet.md, Part 6). Each
 * computer's server keeps its own tasks; this follows every connected
 * computer whose server has the `scheduledTasks` capability (an older
 * Threadlines on another computer simply isn't listed) and keeps each one's
 * latest snapshot. One subscription per computer, mounted once at the root
 * (ScheduledTasksSync), feeds the Scheduled page, its list, the rail and the
 * agents' approval cards.
 */
import type {
  EnvironmentId,
  ScheduledTask,
  ScheduledTaskRequest,
  ScheduledTasksSnapshot,
  ThreadId,
  ThreadScheduledRun,
} from "@threadlines/contracts";
import { useEffect, useMemo } from "react";
import { create } from "zustand";

import { scheduledTaskEnvironmentsOf } from "../components/scheduled/scheduled.logic";
import { usePrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "../environments/primary";
import { useStore } from "../store";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";

/** A computer whose server runs scheduled tasks. */
export interface ScheduledTaskEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  /** Its server runs event tasks too (the `eventTasks` capability). */
  readonly eventTasks: boolean;
}

/** The computers whose servers run scheduled tasks, this one first. */
export function useScheduledTaskEnvironments(): readonly ScheduledTaskEnvironment[] {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const savedById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const runtimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);

  return useMemo(
    () =>
      scheduledTaskEnvironmentsOf({
        primaryEnvironmentId,
        primaryDescriptor,
        runtimeById,
        savedLabelOf: (environmentId) => savedById[environmentId]?.label ?? null,
      }),
    [primaryDescriptor, primaryEnvironmentId, runtimeById, savedById],
  );
}

interface ScheduledTasksState {
  /** Each computer's latest snapshot; absent until its first one arrives. */
  readonly byEnvironment: Readonly<Record<string, ScheduledTasksSnapshot>>;
  readonly put: (environmentId: EnvironmentId, snapshot: ScheduledTasksSnapshot) => void;
  /** Keeps only these computers' snapshots (one gone or no longer supported drops out). */
  readonly keepOnly: (environmentIds: ReadonlySet<string>) => void;
}

export const useScheduledTasksStore = create<ScheduledTasksState>()((set) => ({
  byEnvironment: {},
  put: (environmentId, snapshot) =>
    set((state) => ({ byEnvironment: { ...state.byEnvironment, [environmentId]: snapshot } })),
  keepOnly: (environmentIds) =>
    set((state) => {
      const kept = Object.fromEntries(
        Object.entries(state.byEnvironment).filter(([id]) => environmentIds.has(id)),
      );
      return Object.keys(kept).length === Object.keys(state.byEnvironment).length
        ? state
        : { byEnvironment: kept };
    }),
}));

/**
 * Marks the thread rows whose agent's scheduled-task change waits for the
 * user (setScheduleApprovalThreads), on every computer the thread store
 * knows: again whenever either side changes, so a computer whose threads
 * arrive after its tasks still gets its marks, and one that stops being
 * followed loses them.
 */
function useScheduleApprovalRows() {
  const byEnvironment = useScheduledTasksStore((state) => state.byEnvironment);
  const threadEnvironmentKey = useStore((state) =>
    Object.keys(state.environmentStateById).join("\0"),
  );
  useEffect(() => {
    if (threadEnvironmentKey === "") return;
    const store = useStore.getState();
    for (const environmentId of threadEnvironmentKey.split("\0") as EnvironmentId[]) {
      store.setScheduleApprovalThreads(
        environmentId,
        (byEnvironment[environmentId]?.requests ?? []).map((request) => request.threadId),
      );
    }
  }, [byEnvironment, threadEnvironmentKey]);
}

/**
 * Keeps one subscription to each supporting computer's tasks, and takes a
 * new one only for a computer whose connection was replaced (a reconnect
 * with a new session). Mount once.
 */
export function ScheduledTasksSync() {
  useScheduleApprovalRows();
  const environments = useScheduledTaskEnvironments();
  const environmentKey = environments.map((environment) => environment.environmentId).join("\0");

  useEffect(() => {
    const ids = (environmentKey === "" ? [] : environmentKey.split("\0")) as EnvironmentId[];
    useScheduledTasksStore.getState().keepOnly(new Set(ids));
    const active = new Map<
      EnvironmentId,
      { readonly connection: object; readonly unsubscribe: () => void }
    >();
    const sync = () => {
      for (const environmentId of ids) {
        const connection = readEnvironmentConnection(environmentId);
        const current = active.get(environmentId);
        if (current?.connection === connection) continue;
        current?.unsubscribe();
        active.delete(environmentId);
        if (!connection) continue;
        active.set(environmentId, {
          connection,
          unsubscribe: connection.client.scheduledTasks.subscribe((snapshot) =>
            useScheduledTasksStore.getState().put(environmentId, snapshot),
          ),
        });
      }
    };
    sync();
    const stopWatching = subscribeEnvironmentConnections(sync);
    return () => {
      stopWatching();
      for (const entry of active.values()) entry.unsubscribe();
    };
  }, [environmentKey]);

  return null;
}

/** One computer's tasks, as the Scheduled page groups them. */
export interface ScheduledTaskGroup {
  readonly environment: ScheduledTaskEnvironment;
  /** Null until the computer's first snapshot arrives. */
  readonly tasks: readonly ScheduledTask[] | null;
}

/** Every supporting computer with its tasks, this one first. */
export function useScheduledTaskGroups(): readonly ScheduledTaskGroup[] {
  const environments = useScheduledTaskEnvironments();
  const byEnvironment = useScheduledTasksStore((state) => state.byEnvironment);
  return useMemo(
    () =>
      environments.map((environment) => ({
        environment,
        tasks: byEnvironment[environment.environmentId]?.tasks ?? null,
      })),
    [byEnvironment, environments],
  );
}

const NO_REQUESTS: readonly ScheduledTaskRequest[] = [];

/** An agent's changes to the tasks waiting for the user, from one thread. */
export function useScheduledTaskRequestsForThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): readonly ScheduledTaskRequest[] {
  const requests = useScheduledTasksStore((state) =>
    environmentId === null ? undefined : state.byEnvironment[environmentId]?.requests,
  );
  return useMemo(
    () =>
      requests === undefined || threadId === null
        ? NO_REQUESTS
        : requests.filter((request) => request.threadId === threadId),
    [requests, threadId],
  );
}

/**
 * Active tasks that run again on their own on this computer (not manual,
 * not a one-time task that ran): what keeps it awake for them.
 */
export function countActiveScheduledTasks(snapshot: ScheduledTasksSnapshot | undefined): number {
  return (snapshot?.tasks ?? []).filter(
    (task) => task.status === "active" && task.nextRunAt !== null,
  ).length;
}

/** Scheduled runs at work on this computer: they keep it awake too. */
export function countWorkingScheduledRuns(snapshot: ScheduledTasksSnapshot | undefined): number {
  return (snapshot?.tasks ?? []).reduce((count, task) => count + task.workingRuns, 0);
}

/**
 * A run thread's task name as it is now (the task may have been renamed
 * since), or as it was when the run started when the task is gone or its
 * computer isn't followed.
 */
export function useScheduledRunTaskName(
  environmentId: EnvironmentId | null | undefined,
  scheduledRun: ThreadScheduledRun | null | undefined,
): string | null {
  const current = useScheduledTasksStore((state) =>
    scheduledRun == null || environmentId == null
      ? undefined
      : state.byEnvironment[environmentId]?.tasks.find((task) => task.id === scheduledRun.taskId)
          ?.name,
  );
  return scheduledRun == null ? null : (current ?? scheduledRun.taskName);
}

/**
 * The line that names a run's task, on its inbox row and over its first
 * message: "Event · <task>" for an event task's run, else "Scheduled · <task>".
 */
export function scheduledRunLabel(taskName: string, event: boolean): string {
  return `${event ? "Event" : "Scheduled"} · ${taskName}`;
}

/** scheduledRunLabel for a thread a run started, with the task's name as it is now; null otherwise. */
export function useScheduledRunLabel(
  environmentId: EnvironmentId | null | undefined,
  scheduledRun: ThreadScheduledRun | null | undefined,
): string | null {
  const taskName = useScheduledRunTaskName(environmentId, scheduledRun);
  return taskName === null ? null : scheduledRunLabel(taskName, scheduledRun?.event === true);
}

/** The rail's line for Scheduled: how many tasks are active, everywhere ("3 active"). */
export function describeActiveScheduledTasks(
  byEnvironment: Readonly<Record<string, ScheduledTasksSnapshot>>,
): string | null {
  let active = 0;
  for (const snapshot of Object.values(byEnvironment)) {
    active += snapshot.tasks.filter((task) => task.status === "active").length;
  }
  return active === 0 ? null : `${active} active`;
}
