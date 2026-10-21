/**
 * ScheduledRunTurnEnds - where runtime ingestion hands every turn that ended,
 * once its words are final, so a scheduled task's run (docs/design/fleet.md,
 * Part 6) ends with the turn its own message started. Optional: a server
 * without scheduled tasks leaves it out.
 *
 * @module ScheduledRunTurnEnds
 */
import type { MessageId, ThreadId, TurnId } from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ScheduledRunTurnEndsShape {
  readonly onTurnEnd: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly outcome: "completed" | "failed" | "interrupted";
    readonly error: string | undefined;
    /** The message that started the ended turn, if any. */
    readonly pendingMessageId: MessageId | null;
  }) => Effect.Effect<void>;
}

export class ScheduledRunTurnEnds extends Context.Service<
  ScheduledRunTurnEnds,
  ScheduledRunTurnEndsShape
>()("threadlines/orchestration/Services/ScheduledRunTurnEnds") {}
