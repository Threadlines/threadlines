import * as Schema from "effect/Schema";

import {
  ChildRequestId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  ThreadMoveBatchId,
  ThreadMoveId,
  ThreadMoveRequestId,
  ThreadParticipantId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ComputerLinkAccess } from "./links.ts";
import {
  ModelSelection,
  ThreadMoveHold,
  ThreadMovePhase,
  ThreadMoveRoomAgentChoice,
  ThreadMoveTarget,
  ThreadMoveWait,
  ThreadPendingMoveMode,
} from "./orchestration.ts";
import { PeerAgent } from "./peerRpc.ts";

/**
 * Moving a thread to a linked computer, as clients ask for it
 * (docs/design/fleet.md, Part 3). The server checks the link and the other
 * computer before it freezes the thread; the move then runs on its own.
 */

/** At most this many threads in one `moves.previewMany` or `moves.queueMany`. */
export const THREAD_MOVE_BATCH_MAX = 100;

/**
 * What a move does with the thread's agent session, for one agent on the
 * other computer (docs/design/fleet.md, Part 3d): `carries`, the agent keeps
 * its full memory; `summary`, it gets a summary of the conversation;
 * `too_large`, the summary, because the session is too large to send.
 */
export const ThreadMoveSessionOutcome = Schema.Literals(["carries", "summary", "too_large"]);
export type ThreadMoveSessionOutcome = typeof ThreadMoveSessionOutcome.Type;

export const ThreadMoveAgentSessionOutcome = Schema.Struct({
  /** One of the target's agents, by its own instance id. */
  instanceId: TrimmedNonEmptyString,
  outcome: ThreadMoveSessionOutcome,
});
export type ThreadMoveAgentSessionOutcome = typeof ThreadMoveAgentSessionOutcome.Type;

/**
 * One line the move dialog shows about what a thread takes along, or what
 * won't work as it did: always the server's words. `instanceIds`: it holds
 * only while one of those agents (on the computer it's about) is picked.
 */
export const ThreadMoveNote = Schema.Struct({
  words: TrimmedNonEmptyString,
  instanceIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type ThreadMoveNote = typeof ThreadMoveNote.Type;

/**
 * One room agent on a computer the thread could move to (docs/design/fleet.md,
 * Part 3f, (i)): the agent there to suggest (the same driver and model, else
 * that driver's default model), and what it would get of its session. Absent
 * `suggestedAgent`: none matches, and `cantCome` says so in the server's words
 * ("Sol can't come: Windows PC has no Codex agent.").
 */
export const ThreadMoveRoomAgentTarget = Schema.Struct({
  participantId: ThreadParticipantId,
  suggestedAgent: Schema.optional(ModelSelection),
  cantCome: Schema.optional(TrimmedNonEmptyString),
  /** Per agent there, what it would get of this agent's session; absent: `summary` for every one. */
  sessionOutcomes: Schema.optional(Schema.Array(ThreadMoveAgentSessionOutcome)),
});
export type ThreadMoveRoomAgentTarget = typeof ThreadMoveRoomAgentTarget.Type;

/** One computer this thread could move to, as this computer sees it now. */
export const ThreadMoveTargetPreview = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  /** Why it can't take this thread, in words for the user. Absent: it can. */
  refusal: Schema.optional(TrimmedNonEmptyString),
  /**
   * `no_project`: it has no copy of this project yet; the app can offer to
   * set one up. Never extended: a client from before a new code would fail
   * to read the whole preview, so new reasons get fields of their own.
   */
  refusalCode: Schema.optional(Schema.Literals(["no_project"])),
  /**
   * It can't be reached right now (`refusal` says so). A queued move
   * (`moves.queue`) may still pick it, and waits for it to connect.
   */
  unreachable: Schema.optional(Schema.Literal(true)),
  /** Its project the thread would land in. */
  projectName: Schema.optional(TrimmedNonEmptyString),
  /** Whether its user is asked first, or it takes the move at once. */
  access: Schema.optional(ComputerLinkAccess),
  /** Its ready agents, by its own instance ids. */
  agents: Schema.Array(PeerAgent),
  /** The agent to suggest: the thread's own driver and model when it has them. */
  suggestedAgent: Schema.optional(ModelSelection),
  /**
   * Under Ask first it takes every byte before its user allows the move, so
   * this computer can count the move as sent and quit (docs/design/fleet.md,
   * Part 3c). Absent: it holds the bytes back until Allow.
   */
  stagedApproval: Schema.optional(Schema.Boolean),
  /**
   * For a thread (`moves.preview`), what each of its agents would get of the
   * thread's agent session. An agent not listed, or absent: `summary`.
   */
  sessionOutcomes: Schema.optional(Schema.Array(ThreadMoveAgentSessionOutcome)),
  /**
   * What won't work there as it did here, in the server's words
   * (docs/design/fleet.md, Part 3e): "GitHub isn't signed in on Windows PC…".
   * A note with `instanceIds` holds only for those of its agents (the dialog
   * shows it while one of them is picked); without, for any.
   */
  notes: Schema.optional(Schema.Array(ThreadMoveNote)),
  /** A room (ThreadMovePreview.room): each of its agents on this computer. */
  roomAgents: Schema.optional(Schema.Array(ThreadMoveRoomAgentTarget)),
  /**
   * A child (ThreadMovePreview.family.parent): why it can't move there
   * without its parent, which then has to come along ("Update Threadlines on
   * Windows PC to move it on its own."). Absent: it can.
   */
  aloneRefusal: Schema.optional(TrimmedNonEmptyString),
  /**
   * A thread that started threads on this computer: they become its threads
   * there again (ThreadMovePreview.family.remoteChildren with this
   * `environmentId`). Absent: they stay apart there, as an older server keeps them.
   */
  adoptsChildren: Schema.optional(Schema.Literal(true)),
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
  /**
   * What comes along besides the conversation (docs/design/fleet.md, Part
   * 3e), one line each in the server's words: "Its goal carries on there."
   */
  brings: Schema.optional(Schema.Array(ThreadMoveNote)),
  /** A General Chats thread: its folder, in place of `changes`. */
  folder: Schema.optional(Schema.Struct({ files: NonNegativeInt, bytes: NonNegativeInt })),
  /**
   * A room (docs/design/fleet.md, Part 3f, (i)): its agents besides the
   * thread's own, each with its name here. The dialog picks an agent for each
   * on the chosen computer (ThreadMoveTargetPreview.roomAgents), or leaves it out.
   */
  room: Schema.optional(
    Schema.Struct({
      agents: Schema.Array(
        Schema.Struct({ participantId: ThreadParticipantId, name: TrimmedNonEmptyString }),
      ),
    }),
  ),
  /**
   * A thread that started threads (docs/design/fleet.md, Part 3f, (g)): its
   * children here that can come along, each with why it can't when it can't
   * (it then stays here as its own thread), and the threads its agent
   * started on other computers, which stay there. On a child: its parent,
   * and how many threads moving the whole family moves (`familySize`: the
   * parent and its children here; absent from an older server).
   */
  family: Schema.optional(
    Schema.Struct({
      parent: Schema.optional(
        Schema.Struct({
          threadId: ThreadId,
          title: TrimmedNonEmptyString,
          familySize: Schema.optional(PositiveInt),
        }),
      ),
      children: Schema.Array(
        Schema.Struct({
          threadId: ThreadId,
          title: TrimmedNonEmptyString,
          refusal: Schema.optional(TrimmedNonEmptyString),
        }),
      ),
      remoteChildren: Schema.Array(
        Schema.Struct({
          label: TrimmedNonEmptyString,
          title: TrimmedNonEmptyString,
          /** The computer it is on. Absent from an older server. */
          environmentId: Schema.optional(EnvironmentId),
        }),
      ),
    }),
  ),
  targets: Schema.Array(ThreadMoveTargetPreview),
});
export type ThreadMovePreview = typeof ThreadMovePreview.Type;

/**
 * Which of a parent's children come along (docs/design/fleet.md, Part 3f,
 * review change 5). `explicit`: exactly the threads asked for move, and its
 * children not asked for stay here as their own threads. Absent (an older
 * app): a parent moves with its whole family.
 */
export const ThreadMoveFamilySelection = Schema.Literal("explicit");
export type ThreadMoveFamilySelection = typeof ThreadMoveFamilySelection.Type;

export const ThreadMovePreviewInput = Schema.Struct({ threadId: ThreadId });
export type ThreadMovePreviewInput = typeof ThreadMovePreviewInput.Type;

export const ThreadMoveStartInput = Schema.Struct({
  threadId: ThreadId,
  targetEnvironmentId: EnvironmentId,
  /** One of the target's agents, by its own instance id. */
  agent: ModelSelection,
  /** A room: the agent each of its agents moves as (null leaves it out); one not listed takes the suggestion. */
  roomAgents: Schema.optional(Schema.Array(ThreadMoveRoomAgentChoice)),
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
  /**
   * One of the target's agents, by its own instance id. Absent: the agent
   * the target suggests when the move starts (as the dialog picks it), so a
   * move to a computer that is offline now still gets one.
   */
  agent: Schema.optional(ModelSelection),
  mode: ThreadPendingMoveMode,
  /** A room: the agent each of its agents moves as (null leaves it out); one not listed takes the suggestion. */
  roomAgents: Schema.optional(Schema.Array(ThreadMoveRoomAgentChoice)),
  /** See ThreadMoveFamilySelection. */
  familySelection: Schema.optional(ThreadMoveFamilySelection),
  /**
   * With `familySelection: "explicit"`, the children of this thread that come
   * along, each with the agent the target suggests for it. Absent: none.
   */
  children: Schema.optional(
    Schema.Array(ThreadId).check(Schema.isMaxLength(THREAD_MOVE_BATCH_MAX)),
  ),
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

// ----- several threads at once (docs/design/fleet.md, Part 3c) ---------------------------

const BatchThreadIds = Schema.Array(ThreadId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(THREAD_MOVE_BATCH_MAX),
);

export const ThreadMovePreviewManyInput = Schema.Struct({ threadIds: BatchThreadIds });
export type ThreadMovePreviewManyInput = typeof ThreadMovePreviewManyInput.Type;

/** Why one thread can't go to one computer that could take others (it has no copy of its project). */
export const ThreadMoveTargetRefusal = Schema.Struct({
  environmentId: EnvironmentId,
  refusal: TrimmedNonEmptyString,
  refusalCode: Schema.optional(Schema.Literal("no_project")),
});
export type ThreadMoveTargetRefusal = typeof ThreadMoveTargetRefusal.Type;

/** One thread of `moves.previewMany`: the same checks as `moves.preview`, without its change summary. */
export const ThreadMovePreviewManyThread = Schema.Struct({
  threadId: ThreadId,
  /** Why it can't move anywhere, even once it is free. Absent: it can. */
  refusal: Schema.optional(TrimmedNonEmptyString),
  /** What it is busy with now; absent or empty: it moves at once. */
  waitsFor: Schema.optional(Schema.Array(ThreadMoveWait)),
  /** The computers it alone can't go to, and why. A computer not listed takes it. */
  targetRefusals: Schema.optional(Schema.Array(ThreadMoveTargetRefusal)),
  /** What comes along with it besides the conversation: see ThreadMovePreview.brings. */
  brings: Schema.optional(Schema.Array(ThreadMoveNote)),
  /** A General Chats thread: its folder, as ThreadMovePreview.folder. */
  folder: Schema.optional(Schema.Struct({ files: NonNegativeInt, bytes: NonNegativeInt })),
  /**
   * Per computer that would take it, what is its own there (docs/design/
   * fleet.md, Part 3e): the project it lands in, and what won't work there as
   * it did (ThreadMoveTargetPreview.notes), for the agent a batch moves it
   * with (the one that computer suggests). A computer not listed: nothing.
   */
  targetLines: Schema.optional(
    Schema.Array(
      Schema.Struct({
        environmentId: EnvironmentId,
        projectName: Schema.optional(TrimmedNonEmptyString),
        notes: Schema.optional(Schema.Array(ThreadMoveNote)),
      }),
    ),
  ),
  /**
   * Per computer, what the agent it would suggest for this thread gets of its
   * agent session (docs/design/fleet.md, Part 3d). A computer not listed,
   * or absent: `summary`.
   */
  sessionOutcomes: Schema.optional(
    Schema.Array(
      Schema.Struct({ environmentId: EnvironmentId, outcome: ThreadMoveSessionOutcome }),
    ),
  ),
});
export type ThreadMovePreviewManyThread = typeof ThreadMovePreviewManyThread.Type;

export const ThreadMovePreviewMany = Schema.Struct({
  /** In the order asked; a thread that doesn't exist is refused. */
  threads: Schema.Array(ThreadMovePreviewManyThread),
  /**
   * Each linked computer, read once, as it is for every thread: whether it
   * can be reached, its access and agents. Per-thread fields (project name,
   * suggested agent) are left out; `targetRefusals` holds a thread's own.
   */
  targets: Schema.Array(ThreadMoveTargetPreview),
});
export type ThreadMovePreviewMany = typeof ThreadMovePreviewMany.Type;

/**
 * Queue a move for each thread to one computer, each decided on its own: one
 * refused doesn't stop the others. Each picks the agent the target suggests
 * for it when its move starts.
 */
export const ThreadMoveQueueManyInput = Schema.Struct({
  threadIds: BatchThreadIds,
  targetEnvironmentId: EnvironmentId,
  mode: ThreadPendingMoveMode,
  /** See ThreadMoveFamilySelection: a parent's children come only when listed. */
  familySelection: Schema.optional(ThreadMoveFamilySelection),
});
export type ThreadMoveQueueManyInput = typeof ThreadMoveQueueManyInput.Type;

export const ThreadMoveQueueManyResult = Schema.Struct({
  batchId: ThreadMoveBatchId,
  queued: Schema.Array(Schema.Struct({ threadId: ThreadId, requestId: ThreadMoveRequestId })),
  refused: Schema.Array(Schema.Struct({ threadId: ThreadId, words: TrimmedNonEmptyString })),
});
export type ThreadMoveQueueManyResult = typeof ThreadMoveQueueManyResult.Type;

/**
 * "Stop the agents and move now" for one move already waiting: the request
 * the client shows. One that already started, or ended, is left alone.
 */
export const ThreadMoveSetModeInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ThreadMoveRequestId,
  mode: Schema.Literal("stop-now"),
});
export type ThreadMoveSetModeInput = typeof ThreadMoveSetModeInput.Type;

export const ThreadMoveBatchStatusInput = Schema.Struct({ batchId: ThreadMoveBatchId });
export type ThreadMoveBatchStatusInput = typeof ThreadMoveBatchStatusInput.Type;

/**
 * Where one thread of a batch stands. Still going: `waiting` (for its agent
 * to finish), `stopping` (its agent is being stopped), `moving` (the transfer
 * runs; `phase` says how far). Final: `moved`, `not_moved` (with `words`),
 * and `awaiting_approval` (the other computer has every byte and waits for
 * its user; this computer may quit).
 */
export const ThreadMoveBatchMemberState = Schema.Literals([
  "waiting",
  "stopping",
  "moving",
  "moved",
  "not_moved",
  "awaiting_approval",
]);
export type ThreadMoveBatchMemberState = typeof ThreadMoveBatchMemberState.Type;

export const ThreadMoveBatchMember = Schema.Struct({
  threadId: ThreadId,
  /** Absent: the thread is gone (or has no title). */
  title: Schema.optional(TrimmedNonEmptyString),
  /** Absent: refused when it was queued, so it has no queued move to name. */
  requestId: Schema.optional(ThreadMoveRequestId),
  state: ThreadMoveBatchMemberState,
  /** `moved`, `not_moved` or `awaiting_approval`. */
  final: Schema.Boolean,
  /** `moving`: how far the transfer got. */
  phase: Schema.optional(ThreadMovePhase),
  /** `waiting`: what it waits for. */
  waitsFor: Schema.optional(Schema.Array(ThreadMoveWait)),
  /** `waiting` or `stopping`: what holds it once it is ready. */
  hold: Schema.optional(ThreadMoveHold),
  /** `not_moved`: why. */
  words: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadMoveBatchMember = typeof ThreadMoveBatchMember.Type;

export const ThreadMoveBatchStatus = Schema.Struct({
  batchId: ThreadMoveBatchId,
  target: ThreadMoveTarget,
  createdAt: IsoDateTime,
  /** Every thread asked for, refused ones included, in the order asked. */
  members: Schema.Array(ThreadMoveBatchMember),
  /** Every member is final. */
  final: Schema.Boolean,
});
export type ThreadMoveBatchStatus = typeof ThreadMoveBatchStatus.Type;

/**
 * On the computer moves arrive at: answer several moves from one linked
 * computer at once (the grouped card's Allow all and Don't allow). Only the
 * moves the card shows: one that arrives meanwhile waits for its own answer.
 */
export const ThreadMoveRespondManyInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  requestIds: Schema.Array(ChildRequestId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(THREAD_MOVE_BATCH_MAX),
  ),
  allow: Schema.Boolean,
});
export type ThreadMoveRespondManyInput = typeof ThreadMoveRespondManyInput.Type;

export const ThreadMoveRespondManyResult = Schema.Struct({
  answered: Schema.Array(ChildRequestId),
  /** The ones that couldn't be answered (no longer waiting, or not recorded), and why. */
  failed: Schema.Array(Schema.Struct({ requestId: ChildRequestId, detail: TrimmedNonEmptyString })),
});
export type ThreadMoveRespondManyResult = typeof ThreadMoveRespondManyResult.Type;

export class ThreadMoveError extends Schema.TaggedError<ThreadMoveError>()("ThreadMoveError", {
  detail: TrimmedNonEmptyString,
}) {
  override get message(): string {
    return this.detail;
  }
}
