import type { OrchestrationAwaitedBackgroundTask } from "@threadlines/contracts";

/**
 * Whether two lists of the tasks a session waits on say the same thing, in
 * order, field by field. The server decides from this whether a provider
 * snapshot changes the session, and the client whether an update changes its
 * copy: if they disagree on a field, one side keeps a stale list (a Stop aimed
 * at a task that already ended).
 */
export function sameAwaitedBackgroundTasks(
  left: ReadonlyArray<OrchestrationAwaitedBackgroundTask> | undefined,
  right: ReadonlyArray<OrchestrationAwaitedBackgroundTask> | undefined,
): boolean {
  if (left === right) return true;
  const leftTasks = left ?? [];
  const rightTasks = right ?? [];
  return (
    leftTasks.length === rightTasks.length &&
    leftTasks.every((task, index) => {
      const other = rightTasks[index];
      return (
        other !== undefined &&
        task.kind === other.kind &&
        task.description === other.description &&
        task.taskId === other.taskId &&
        task.toolUseId === other.toolUseId &&
        task.stoppable === other.stoppable
      );
    })
  );
}
