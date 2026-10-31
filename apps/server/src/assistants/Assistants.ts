/**
 * The assistants door on this computer (docs/design/assistants.md): always-on
 * assistants in their makers' clouds reach Threadlines through the relay's
 * public address, and this computer approves them, mints and checks every
 * credential, and answers their requests.
 *
 * AssistantsLive implements it over the relay (AssistantRelay) and the
 * `outside_agent_connections` rows. OutsideAgentConnectionsLive puts it in
 * front of the user: the snapshot's `assistants`, Approve and Deny of an
 * assistant's sign-in, codes and keys. AssistantMcpServer answers its MCP
 * requests (`serveMcp`) with the same tools as the local door.
 *
 * In memory (a restart cancels them): the code showing, sign-ins waiting for
 * the user, authorization codes, Deny all's quiet period. Durable: the
 * connection rows, with each one's refresh state or key hash, and the
 * revocations the relay still has to hear about.
 */
import type {
  OutsideAgentApproveInput,
  OutsideAgentAssistantsState,
  OutsideAgentConnection,
  OutsideAgentCreateKeyInput,
  OutsideAgentCreateKeyResult,
  OutsideAgentError,
  OutsideAgentRequestId,
  RelayAssistantCodeResult,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { OutsideAgentCaller } from "../outsideAgents/OutsideAgentConnections.ts";

/** An assistant's request as the relay passed it on. */
export interface AssistantHttpRequest {
  /** The bearer from `Authorization`. Never logged. */
  readonly credential: string;
  /** The canonical resource it came to, `<origin>/mcp`. */
  readonly resource: string;
  /** Only the headers the relay passes on, names lowercased. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** The answer the relay passes back as the HTTP response. */
export interface AssistantHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** This computer couldn't check a credential just now (its store failed): answer 503, never 401. */
export class AssistantUnavailable extends Data.TaggedError("AssistantUnavailable")<{}> {}

export type AssistantMcpHandler = (
  request: AssistantHttpRequest,
) => Effect.Effect<AssistantHttpResponse>;

export interface AssistantsShape {
  /**
   * The snapshot's `assistants`, but for the alert targets (AssistantAlerts',
   * added where the snapshot is sent). Reading it asks the relay again when
   * what it said is stale.
   */
  readonly state: Effect.Effect<Omit<OutsideAgentAssistantsState, "alertTargets">>;
  /** Something in `state`, or an assistant connection, changed. */
  readonly changes: Stream.Stream<void>;
  /** Whether `requestId` is an assistant's sign-in waiting for the user. */
  readonly isWaiting: (requestId: OutsideAgentRequestId) => Effect.Effect<boolean>;
  /**
   * Allows a waiting sign-in with what the user picked (at most what it asked
   * for): the relay hands its page an authorization code, and the connection
   * is saved when the assistant exchanges it. Returns it as it will be.
   */
  readonly approve: (
    input: OutsideAgentApproveInput,
  ) => Effect.Effect<OutsideAgentConnection, OutsideAgentError>;
  readonly deny: (requestId: OutsideAgentRequestId) => Effect.Effect<void>;
  /** Deny all: denies every waiting sign-in, and every new one until `until` (null: take them again). */
  readonly setQuiet: (until: number | null) => Effect.Effect<void>;
  /** Shows a sign-in code (replacing any) and opens the assistant socket. */
  readonly createCode: Effect.Effect<RelayAssistantCodeResult, OutsideAgentError>;
  readonly cancelCode: Effect.Effect<void, OutsideAgentError>;
  /** A key-signed connection; the key is in the result only. */
  readonly createKey: (
    input: OutsideAgentCreateKeyInput,
  ) => Effect.Effect<OutsideAgentCreateKeyResult, OutsideAgentError>;
  /**
   * Connection rows changed elsewhere (a Remove): tells the relay about
   * removed assistant connections and reconsiders whether the socket is needed.
   */
  readonly connectionsChanged: Effect.Effect<void>;
  /**
   * The connection behind an MCP request's credential (an access token or a
   * key), checked against its live row; null: answer 401.
   */
  readonly authenticate: (input: {
    readonly credential: string;
    readonly resource: string;
  }) => Effect.Effect<OutsideAgentCaller | null, AssistantUnavailable>;
  /** Answers the relay's `mcp` requests with `handler` while the scope lasts. */
  readonly serveMcp: (handler: AssistantMcpHandler) => Effect.Effect<void, never, Scope.Scope>;
}

export class Assistants extends Context.Service<Assistants, AssistantsShape>()(
  "threadlines/assistants/Assistants",
) {}
