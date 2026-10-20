/**
 * RemoteRequestTurnEnds - where runtime ingestion hands a turn that ended in
 * a thread a linked computer's agent started here (docs/design/fleet.md,
 * "Records on B"). Called at the same point a local child's answer goes back
 * to its parent: once the turn's words are final. Optional: a server without
 * computer links leaves it out.
 *
 * @module RemoteRequestTurnEnds
 */
import type { MessageId, OrchestrationThread } from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ChildTurnEnd } from "../childThreadDelivery.ts";

export interface RemoteRequestTurnEndsShape {
  readonly onTurnEnd: (input: {
    readonly child: OrchestrationThread;
    readonly end: ChildTurnEnd;
    /** The message that started the ended turn, if any. */
    readonly pendingMessageId: MessageId | null;
    readonly createdAt: string;
  }) => Effect.Effect<void>;
}

export class RemoteRequestTurnEnds extends Context.Service<
  RemoteRequestTurnEnds,
  RemoteRequestTurnEndsShape
>()("threadlines/orchestration/Services/RemoteRequestTurnEnds") {}
