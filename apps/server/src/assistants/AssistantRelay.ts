/**
 * The relay as the assistants door sees it (docs/design/assistants.md,
 * "Between the relay and the computer"): host-secret calls under
 * `/v2/hosts/{hostId}/assistants`, and the assistant socket.
 *
 * AssistantRelayLive implements it over this computer's relay registration
 * (RelayHostLink); tests give the door a fake one.
 *
 * - Every call that needs a host registers this computer first when it
 *   isn't, except `revoke` (nothing to revoke on a host that doesn't exist)
 *   and `info` without `register`.
 * - The socket is open while `setWanted(true)` holds and this computer is
 *   registered, reconnecting with backoff (0.5 s to 30 s). `events` carries
 *   the relay's frames in arrival order, decoded (unknown ones and ones over
 *   RELAY_ASSISTANT_FRAME_MAX_BYTES are dropped), and when the socket opens
 *   or closes.
 */
import type {
  OutsideAgentConnectionId,
  RelayAssistantCodeResult,
  RelayAssistantHostFrame,
  RelayAssistantInfo,
  RelayAssistantRelayFrame,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * A relay call that didn't work.
 * - `unreachable`: the relay couldn't be reached, or was busy or failing.
 * - `off`: the relay's assistants door is turned off, or it has none.
 * - `refused`: anything else the relay refused; `detail` says what.
 */
export class AssistantRelayError extends Data.TaggedError("AssistantRelayError")<{
  readonly reason: "unreachable" | "off" | "refused";
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

export type AssistantRelayEvent =
  | { readonly type: "frame"; readonly frame: RelayAssistantRelayFrame }
  | { readonly type: "open" }
  | { readonly type: "closed" };

export interface AssistantRelayShape {
  /** False when this computer's relay is turned off (no valid relay address). */
  readonly available: boolean;
  /** This computer's relay host id; null while it isn't registered. */
  readonly hostId: Effect.Effect<string | null>;
  /**
   * The door's address and whether it is on. Not registered and `register`
   * false: the relay's public answer (`GET /v2/assistants`), which registers
   * nothing; null only when a fake relay has no answer.
   */
  readonly info: (options: {
    readonly register: boolean;
  }) => Effect.Effect<RelayAssistantInfo | null, AssistantRelayError>;
  readonly createCode: Effect.Effect<RelayAssistantCodeResult, AssistantRelayError>;
  readonly cancelCode: Effect.Effect<void, AssistantRelayError>;
  /** A new connection's route tag, and the host it is under. */
  readonly routeTag: (
    connectionId: OutsideAgentConnectionId,
  ) => Effect.Effect<{ readonly hostId: string; readonly routeTag: string }, AssistantRelayError>;
  /** Tells the relay these connections of `hostId` were removed. At most 100 at a time. */
  readonly revoke: (input: {
    readonly hostId: string;
    readonly connectionIds: ReadonlyArray<OutsideAgentConnectionId>;
  }) => Effect.Effect<void, AssistantRelayError>;
  /** Keep the assistant socket (and the relay link's lease) up while true. */
  readonly setWanted: (wanted: boolean) => Effect.Effect<void>;
  readonly events: Stream.Stream<AssistantRelayEvent>;
  /** Sends a frame on the socket; false when it isn't open (or the frame is too large). */
  readonly send: (frame: RelayAssistantHostFrame) => Effect.Effect<boolean>;
}

export class AssistantRelay extends Context.Service<AssistantRelay, AssistantRelayShape>()(
  "threadlines/assistants/AssistantRelay",
) {}

const turnedOff = new AssistantRelayError({
  reason: "off",
  detail: "This computer's relay is turned off.",
});

/** A relay that is turned off: nothing to reach, no socket. For servers and tests without one. */
export const assistantRelayOff: AssistantRelayShape = {
  available: false,
  hostId: Effect.succeed(null),
  info: () => Effect.succeed(null),
  createCode: Effect.fail(turnedOff),
  cancelCode: Effect.void,
  routeTag: () => Effect.fail(turnedOff),
  revoke: () => Effect.void,
  setWanted: () => Effect.void,
  events: Stream.empty,
  send: () => Effect.succeed(false),
};
