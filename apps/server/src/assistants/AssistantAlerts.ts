/**
 * Alerts to a web address (docs/design/assistants.md, "Build plan: step 4"):
 * the computer POSTs each recorded event of the picked kinds and projects to
 * the address the user added (a Grok routine's webhook, say), signed with
 * Standard Webhooks headers and the target's own `whsec_` secret.
 *
 * Read from the assistants' event record (AssistantEvents), which runs while
 * a target is on. Each target keeps a watermark into the record: an event
 * still retrying holds it back, so none is skipped. A send is tried again
 * only when it plainly didn't arrive (or the receiver asked for it again);
 * one that may have arrived is never sent twice. Settings › Connections ›
 * Assistants manages them, owner only.
 *
 * An assistant's MCP Events subscription (docs/design/assistants.md, "Build
 * plan: step 5") is a target too, sent by the same loop: it belongs to the
 * assistant's connection, signs with the key the assistant gave, and stops
 * at its expiry unless the assistant subscribes again.
 */
import type {
  AssistantAlertTarget,
  AssistantAlertTargetCreateInput,
  AssistantAlertTargetInput,
  AssistantAlertTargetSecretResult,
  AssistantAlertTargetSetOnInput,
  AssistantAlertTargetTestResult,
  AssistantAlertTargetUpdateInput,
  OutsideAgentConnectionId,
  OutsideAgentError,
  ProjectId,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { AssistantEventName } from "./AssistantEvents.ts";

/** MCP Events' JSON-RPC errors (the plugin guide's codes). */
export const SUBSCRIBE_ERROR = {
  callbackEndpoint: -32015,
  eventNotFound: -32023,
  forbidden: -32024,
  resourceExhausted: -32025,
  invalidParams: -32602,
  internal: -32603,
} as const;

/** Why a callback was refused; coarse, so a check can't be used to map a network. */
export type CallbackRefusal =
  | "blocked_address"
  | "timeout"
  | "unreachable"
  | "bad_status"
  | "challenge_failed";

/** A subscribe or unsubscribe turned down, as the JSON-RPC error the door answers with. */
export class AssistantSubscriptionError extends Data.TaggedError("AssistantSubscriptionError")<{
  readonly code: number;
  readonly message: string;
  readonly reason?: CallbackRefusal;
}> {}

/** What identifies a subscription, with the caller. */
export interface AssistantSubscriptionKey {
  readonly connectionId: OutsideAgentConnectionId;
  /** The callback, normalized. */
  readonly url: string;
  readonly name: AssistantEventName;
  /** The arguments as sent, canonical JSON. */
  readonly argumentsJson: string;
}

export interface AssistantSubscribeInput extends AssistantSubscriptionKey {
  /** What the arguments resolve to; null: every project the caller's grant reaches. */
  readonly projectIds: ReadonlyArray<ProjectId> | null;
  /**
   * The projects it may hear about now (its grant, without General Chats): a
   * resume's limit counts only their events, so others can't crowd them out.
   */
  readonly reachableProjectIds: ReadonlyArray<ProjectId>;
  /** The key the caller signs check by, its bytes. */
  readonly secret: Uint8Array;
  /** The last cursor the caller saved; null: none. */
  readonly cursor: string | null;
  /** How long it asks to last; null or left out: the longest there is. */
  readonly ttlMs?: number | null;
  /** How far back a resume may reach, when less than the most there is. */
  readonly maxAgeMs?: number;
}

export interface AssistantSubscribeResult {
  readonly id: string;
  readonly refreshBefore: string;
  readonly cursor: string;
  readonly truncated: boolean;
}

export interface AssistantAlertsShape {
  /** The targets now, then again after every change; oldest first, without secrets. */
  readonly targets: Stream.Stream<ReadonlyArray<AssistantAlertTarget>, OutsideAgentError>;
  /** Adds a target, on from now: nothing that happened before is sent. */
  readonly create: (
    input: AssistantAlertTargetCreateInput,
  ) => Effect.Effect<AssistantAlertTargetInput, OutsideAgentError>;
  readonly update: (
    input: AssistantAlertTargetUpdateInput,
  ) => Effect.Effect<void, OutsideAgentError>;
  /** Turns sending on (from now) or off. */
  readonly setOn: (input: AssistantAlertTargetSetOnInput) => Effect.Effect<void, OutsideAgentError>;
  /** Forgets the target, its secrets and its deliveries. */
  readonly remove: (input: AssistantAlertTargetInput) => Effect.Effect<void, OutsideAgentError>;
  /** Sends a `threadlines.test` alert now and says how it went. */
  readonly test: (
    input: AssistantAlertTargetInput,
  ) => Effect.Effect<AssistantAlertTargetTestResult, OutsideAgentError>;
  /** The signing secret, for the receiver to check signatures with. */
  readonly secret: (
    input: AssistantAlertTargetInput,
  ) => Effect.Effect<AssistantAlertTargetSecretResult, OutsideAgentError>;
  /**
   * An assistant's MCP Events subscribe: checks the callback unless this
   * caller checked it lately, then makes the subscription or refreshes it.
   * A repeat with the same key is a refresh.
   */
  readonly subscribe: (
    input: AssistantSubscribeInput,
  ) => Effect.Effect<AssistantSubscribeResult, AssistantSubscriptionError>;
  /** Forgets the subscription with this key, if there is one. */
  readonly unsubscribe: (
    input: AssistantSubscriptionKey,
  ) => Effect.Effect<void, AssistantSubscriptionError>;
  /** Sends until the scope closes. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class AssistantAlerts extends Context.Service<AssistantAlerts, AssistantAlertsShape>()(
  "threadlines/assistants/AssistantAlerts",
) {}
