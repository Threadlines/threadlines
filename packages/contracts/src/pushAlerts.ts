import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PushRegistrationId, PushVapidKeyId, RelayDeviceAlertOutcome } from "./relay.ts";

const Base64UrlText = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));

/**
 * `push.register`: what a paired phone gives a computer for its alerts
 * (docs/design/push-alerts.md). Only the keys to seal alerts with: the
 * subscription's endpoint goes to the relay, never to the computer. Phones
 * send it on every launch and connection; the same subscription again
 * changes nothing.
 */
export const PushRegisterInput = Schema.Struct({
  registrationId: PushRegistrationId,
  /** The subscription's P-256 public key (65 bytes) and auth secret (16 bytes), base64url. */
  p256dh: Base64UrlText.check(Schema.isMaxLength(100)),
  auth: Base64UrlText.check(Schema.isMaxLength(40)),
  keyId: PushVapidKeyId,
  /** The phone's app, where tapping an alert opens its thread. */
  appOrigin: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type PushRegisterInput = typeof PushRegisterInput.Type;

/** `push.sendTest`: what became of the test alert (see RelayDeviceAlertOutcome). */
export const PushSendTestResult = Schema.Struct({
  outcome: RelayDeviceAlertOutcome,
});
export type PushSendTestResult = typeof PushSendTestResult.Type;

/** `presence.setViewing`: the thread this connection shows right now, or none. */
export const PresenceSetViewingInput = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
});
export type PresenceSetViewingInput = typeof PresenceSetViewingInput.Type;

/**
 * Why a push call can't go ahead. `not-a-paired-phone`: only a device paired
 * through Connect a device gets alerts. `not-registered`: send a test before
 * registering. `relay-unavailable`: this computer isn't on a relay that sends
 * alerts. `invalid`: the input doesn't hold up.
 */
export const PushAlertsErrorCode = Schema.Literals([
  "not-a-paired-phone",
  "not-registered",
  "relay-unavailable",
  "invalid",
]);
export type PushAlertsErrorCode = typeof PushAlertsErrorCode.Type;

export class PushAlertsError extends Schema.TaggedError<PushAlertsError>()("PushAlertsError", {
  code: PushAlertsErrorCode,
  detail: TrimmedNonEmptyString,
}) {
  override get message(): string {
    return this.detail;
  }
}
