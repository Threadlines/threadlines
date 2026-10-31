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
 */
import type {
  AssistantAlertTarget,
  AssistantAlertTargetCreateInput,
  AssistantAlertTargetInput,
  AssistantAlertTargetSecretResult,
  AssistantAlertTargetSetOnInput,
  AssistantAlertTargetTestResult,
  AssistantAlertTargetUpdateInput,
  OutsideAgentError,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

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
  /** Sends until the scope closes. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class AssistantAlerts extends Context.Service<AssistantAlerts, AssistantAlertsShape>()(
  "threadlines/assistants/AssistantAlerts",
) {}
