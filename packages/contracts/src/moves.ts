import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  ThreadId,
  ThreadMoveId,
  ThreadMoveRequestId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ComputerLinkAccess } from "./links.ts";
import { ModelSelection, ThreadMoveWait, ThreadPendingMoveMode } from "./orchestration.ts";
import { PeerAgent } from "./peerRpc.ts";

/**
 * Moving a thread to a linked computer, as clients ask for it
 * (docs/design/fleet.md, Part 3). The server checks the link and the other
 * computer before it freezes the thread; the move then runs on its own.
 */

/** One computer this thread could move to, as this computer sees it now. */
export const ThreadMoveTargetPreview = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  /** Why it can't take this thread, in words for the user. Absent: it can. */
  refusal: Schema.optional(TrimmedNonEmptyString),
  /** `no_project`: it has no copy of this project yet; the app can offer to set one up. */
  refusalCode: Schema.optional(Schema.Literals(["no_project"])),
  /** Its project the thread would land in. */
  projectName: Schema.optional(TrimmedNonEmptyString),
  /** Whether its user is asked first, or it takes the move at once. */
  access: Schema.optional(ComputerLinkAccess),
  /** Its ready agents, by its own instance ids. */
  agents: Schema.Array(PeerAgent),
  /** The agent to suggest: the thread's own driver and model when it has them. */
  suggestedAgent: Schema.optional(ModelSelection),
});
export type ThreadMoveTargetPreview = typeof ThreadMoveTargetPreview.Type;

/** What moving this thread would take with it. */
export const ThreadMoveChanges = Schema.Struct({
  /** Null: a detached head. */
  branch: Schema.NullOr(TrimmedNonEmptyString),
  trackedFiles: NonNegativeInt,
  untrackedFiles: NonNegativeInt,
  unpushedCommits: NonNegativeInt,
  messageCount: NonNegativeInt,
});
export type ThreadMoveChanges = typeof ThreadMoveChanges.Type;

export const ThreadMovePreview = Schema.Struct({
  /**
   * Why this thread can't move, even once it is free: something only the
   * user can clear (a goal, queued messages, a room...). Absent: it can.
   */
  refusal: Schema.optional(TrimmedNonEmptyString),
  /**
   * What it is busy with now (docs/design/fleet.md, Part 3b). With no
   * `refusal`, the dialog offers "Move when it's done" and "Stop and move
   * now" (`moves.queue`). Absent or empty: it is free.
   */
  waitsFor: Schema.optional(Schema.Array(ThreadMoveWait)),
  changes: Schema.optional(ThreadMoveChanges),
  targets: Schema.Array(ThreadMoveTargetPreview),
});
export type ThreadMovePreview = typeof ThreadMovePreview.Type;

export const ThreadMovePreviewInput = Schema.Struct({ threadId: ThreadId });
export type ThreadMovePreviewInput = typeof ThreadMovePreviewInput.Type;

export const ThreadMoveStartInput = Schema.Struct({
  threadId: ThreadId,
  targetEnvironmentId: EnvironmentId,
  /** One of the target's agents, by its own instance id. */
  agent: ModelSelection,
});
export type ThreadMoveStartInput = typeof ThreadMoveStartInput.Type;

export const ThreadMoveStartResult = Schema.Struct({ transferId: ThreadMoveId });
export type ThreadMoveStartResult = typeof ThreadMoveStartResult.Type;

export const ThreadMoveCancelInput = Schema.Struct({ threadId: ThreadId });
export type ThreadMoveCancelInput = typeof ThreadMoveCancelInput.Type;

/**
 * Queue a move that starts once the thread is free (`when-done`), or once
 * its agent session is ended (`stop-now`): docs/design/fleet.md, Part 3b.
 * The thread's pending move (OrchestrationThread.pendingMove) shows it.
 */
export const ThreadMoveQueueInput = Schema.Struct({
  threadId: ThreadId,
  targetEnvironmentId: EnvironmentId,
  /** One of the target's agents, by its own instance id. */
  agent: ModelSelection,
  mode: ThreadPendingMoveMode,
});
export type ThreadMoveQueueInput = typeof ThreadMoveQueueInput.Type;

export const ThreadMoveQueueResult = Schema.Struct({ requestId: ThreadMoveRequestId });
export type ThreadMoveQueueResult = typeof ThreadMoveQueueResult.Type;

/**
 * Cancel a queued move: the `requestId` the client shows, never "whatever is
 * queued now". If that move already started, its transfer is cancelled
 * instead (as `moves.cancel` would).
 */
export const ThreadMoveUnqueueInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ThreadMoveRequestId,
});
export type ThreadMoveUnqueueInput = typeof ThreadMoveUnqueueInput.Type;

/** Try a held queued move again now (ThreadPendingMove.hold): its Try again. */
export const ThreadMoveRetryInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ThreadMoveRequestId,
});
export type ThreadMoveRetryInput = typeof ThreadMoveRetryInput.Type;

export class ThreadMoveError extends Schema.TaggedError<ThreadMoveError>()("ThreadMoveError", {
  detail: TrimmedNonEmptyString,
}) {
  override get message(): string {
    return this.detail;
  }
}
