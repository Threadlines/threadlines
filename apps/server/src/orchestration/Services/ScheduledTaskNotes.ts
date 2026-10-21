/**
 * ScheduledTaskNotes - what an agent asked of the scheduled tasks
 * (schedule_create, schedule_update) and the user answered since its last
 * turn, as the lines that turn carries (docs/design/fleet.md, Part 6). The
 * provider command reactor reads them when it builds a turn and marks them
 * delivered once the provider took it, the way child threads' notes go.
 * Optional: a server without scheduled tasks leaves it out.
 *
 * @module ScheduledTaskNotes
 */
import type { ThreadId, ThreadParticipantId } from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ScheduledTaskNote {
  readonly requestId: string;
  /** One sentence for the agent: "The user allowed your scheduled task …". */
  readonly text: string;
}

export interface ScheduledTaskNotesShape {
  /** One agent's answered requests it hasn't heard about; none on a failed read. */
  readonly pendingFor: (
    threadId: ThreadId,
    participantId: ThreadParticipantId | null,
  ) => Effect.Effect<ReadonlyArray<ScheduledTaskNote>>;
  /** These went out with a turn the provider took. */
  readonly delivered: (requestIds: ReadonlyArray<string>) => Effect.Effect<void>;
}

export class ScheduledTaskNotes extends Context.Service<
  ScheduledTaskNotes,
  ScheduledTaskNotesShape
>()("threadlines/orchestration/Services/ScheduledTaskNotes") {}
