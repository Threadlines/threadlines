/**
 * RemoteRequestGate - asked right before a turn that answers a linked
 * computer's request (its message's `fromThread.kind === "request"` with an
 * `environmentId`) goes to the provider, and before such a queued message is
 * sent (docs/design/fleet.md, "Records on B"). The turn's message id is the
 * one the link ledger reserved for the request (a start's first message, or
 * a send). A request that computer took back must never run: not if its
 * queue command landed late, not if its first turn was already asked for,
 * not while the clean-up that would unqueue it hasn't landed. Optional: a
 * server without computer links leaves it out.
 *
 * @module RemoteRequestGate
 */
import type { MessageId, ThreadId } from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * `run`: send it. `taken-back`: its request ended without it running (a
 * cancel, a refusal, an expiry); it must not run. `unknown`: the record
 * couldn't be read; hold it and ask again later.
 */
export type RemoteRequestVerdict = "run" | "taken-back" | "unknown";

export interface RemoteRequestGateShape {
  readonly messageVerdict: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<RemoteRequestVerdict>;
}

export class RemoteRequestGate extends Context.Service<RemoteRequestGate, RemoteRequestGateShape>()(
  "threadlines/orchestration/Services/RemoteRequestGate",
) {}
