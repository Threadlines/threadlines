/**
 * RemoteRequestGate - asked before a queued message a linked computer's
 * agent sent (`fromThread.kind === "request"` with an `environmentId`) is
 * sent as a turn (docs/design/fleet.md, "Records on B"). A request that
 * computer took back must never run, even while the clean-up that takes
 * its message out of the queue hasn't landed yet. Optional: a server
 * without computer links leaves it out.
 *
 * @module RemoteRequestGate
 */
import type { MessageId, ThreadId } from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * `run`: send it. `taken-back`: its request ended without it running; take
 * it out of the queue instead. `unknown`: the record couldn't be read; leave
 * it queued for now.
 */
export type RemoteQueuedMessageVerdict = "run" | "taken-back" | "unknown";

export interface RemoteRequestGateShape {
  readonly queuedMessage: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<RemoteQueuedMessageVerdict>;
}

export class RemoteRequestGate extends Context.Service<RemoteRequestGate, RemoteRequestGateShape>()(
  "threadlines/orchestration/Services/RemoteRequestGate",
) {}
