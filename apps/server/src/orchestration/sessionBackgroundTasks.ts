import type {
  AwaitedWorkflowProgress,
  OrchestrationAwaitedBackgroundTask,
  OrchestrationBackgroundTaskKind,
  OrchestrationSession,
  RuntimeTaskId,
} from "@threadlines/contracts";

/**
 * The background-task fields of a thread's session, kept together: every
 * place that rebuilds a session either carries all of them or resets all of
 * them, so a count never outlives the list that describes it.
 */
export interface SessionBackgroundTasks {
  readonly pendingBackgroundTaskCount: number;
  readonly awaitedBackgroundTaskCount: number;
  readonly awaitedBackgroundTasks: ReadonlyArray<OrchestrationAwaitedBackgroundTask>;
}

/** The runtime that held the tasks is gone, or never had any. */
export const NO_BACKGROUND_TASKS: SessionBackgroundTasks = {
  pendingBackgroundTaskCount: 0,
  awaitedBackgroundTaskCount: 0,
  awaitedBackgroundTasks: [],
};

/**
 * A session's background tasks, carried unchanged into a rebuilt session.
 * Sessions written before the awaited split awaited every pending task.
 */
export function carriedBackgroundTasks(
  session:
    | Pick<
        OrchestrationSession,
        "pendingBackgroundTaskCount" | "awaitedBackgroundTaskCount" | "awaitedBackgroundTasks"
      >
    | null
    | undefined,
): SessionBackgroundTasks {
  return {
    pendingBackgroundTaskCount: session?.pendingBackgroundTaskCount ?? 0,
    awaitedBackgroundTaskCount:
      session?.awaitedBackgroundTaskCount ?? session?.pendingBackgroundTaskCount ?? 0,
    awaitedBackgroundTasks: session?.awaitedBackgroundTasks ?? [],
  };
}

/** Longest task description a session carries. The provider allows far more
 *  (Claude: 1000 characters), and the sidebar shows one line of it. */
const AWAITED_TASK_DESCRIPTION_MAX_LENGTH = 120;

/** One awaited task as the session carries it: its kind, a clipped
 *  description, how to stop it on its own when its driver can, and a
 *  workflow's progress. */
export function toAwaitedBackgroundTask(task: {
  readonly kind?: OrchestrationBackgroundTaskKind | undefined;
  readonly description?: string | undefined;
  readonly taskId?: RuntimeTaskId | undefined;
  readonly toolUseId?: string | undefined;
  readonly stoppable?: boolean | undefined;
  readonly workflow?: AwaitedWorkflowProgress | undefined;
}): OrchestrationAwaitedBackgroundTask {
  const description = task.description?.trim();
  const toolUseId = task.toolUseId?.trim();
  return {
    kind: task.kind ?? "other",
    ...(task.taskId !== undefined ? { taskId: task.taskId } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    ...(task.stoppable === true ? { stoppable: true } : {}),
    ...(task.workflow !== undefined ? { workflow: task.workflow } : {}),
    ...(description
      ? {
          description:
            description.length > AWAITED_TASK_DESCRIPTION_MAX_LENGTH
              ? `${description.slice(0, AWAITED_TASK_DESCRIPTION_MAX_LENGTH - 1).trimEnd()}…`
              : description,
        }
      : {}),
  };
}

export { sameAwaitedBackgroundTasks } from "@threadlines/shared/awaitedBackgroundTasks";
