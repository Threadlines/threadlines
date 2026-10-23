/**
 * Ids for a scheduled task's run (docs/design/fleet.md, Part 6), derived from
 * the task and its slot, so every attempt at launching one slot (a retry, a
 * resume after a crash) lands on the same thread, message, worktree branch
 * and command receipts instead of making another.
 */
import {
  ChildRequestId,
  CommandId,
  MessageId,
  type ScheduledTaskId,
  ThreadId,
} from "@threadlines/contracts";

import { derivedUuid } from "../orchestration/childRequestIds.ts";

/** The key a new-thread run's setup runs under (ThreadBootstrap's command ids, its branch). */
export const scheduledRunKey = (taskId: ScheduledTaskId, slotUtc: string): ChildRequestId =>
  ChildRequestId.make(derivedUuid("scheduled-run", taskId, slotUtc));

/** The thread a new-thread run makes. */
export const scheduledRunThreadId = (taskId: ScheduledTaskId, slotUtc: string): ThreadId =>
  ThreadId.make(derivedUuid("scheduled-run-thread", taskId, slotUtc));

/** The message a run writes: the first of its thread, or the follow-up it sends. */
export const scheduledRunMessageId = (taskId: ScheduledTaskId, slotUtc: string): MessageId =>
  MessageId.make(derivedUuid("scheduled-run-message", taskId, slotUtc));

/** A command one step of a run dispatches. */
export const scheduledRunCommandId = (
  taskId: ScheduledTaskId,
  slotUtc: string,
  step: string,
): CommandId => CommandId.make(`server:scheduled-run:${derivedUuid(taskId, slotUtc)}:${step}`);
