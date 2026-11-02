import * as Schema from "effect/Schema";

import { SettingsChangeRequestId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SettingsChangeClaim, SettingsChangeDeviceReport } from "./orchestration.ts";

/**
 * Answering an agent's settings change, sent to the thread's own computer
 * (docs/design/agent-settings-changes.md). Not now changes nothing. Change
 * claims the card for the app that pressed it; that app alone makes the
 * device changes, after its claim wins.
 */
export const SettingsChangeRespondInput = Schema.Struct({
  threadId: ThreadId,
  requestId: SettingsChangeRequestId,
  allow: Schema.Boolean,
  /** Change only: made once per request by the app, and sent again on its retries. */
  claim: Schema.optional(SettingsChangeClaim),
});
export type SettingsChangeRespondInput = typeof SettingsChangeRespondInput.Type;

/**
 * How the answer went. `changed`, `failed` and `uncertain` are about the
 * computer's changes; `makeDeviceChanges` says this app's claim won, so it
 * makes the device changes now (whatever the computer's part did).
 */
export const SettingsChangeAnswer = Schema.Struct({
  outcome: Schema.Literals([
    "changed",
    "declined",
    "failed",
    "uncertain",
    "already_answered",
    "cancelled",
    "gone",
  ]),
  detail: Schema.optional(TrimmedNonEmptyString),
  makeDeviceChanges: Schema.Boolean,
});
export type SettingsChangeAnswer = typeof SettingsChangeAnswer.Type;

/** The claiming app made its device changes; what each did. */
export const SettingsChangeReportDeviceInput = Schema.Struct({
  threadId: ThreadId,
  requestId: SettingsChangeRequestId,
  claimId: TrimmedNonEmptyString,
  device: SettingsChangeDeviceReport,
});
export type SettingsChangeReportDeviceInput = typeof SettingsChangeReportDeviceInput.Type;

export class SettingsChangeError extends Schema.TaggedError<SettingsChangeError>()(
  "SettingsChangeError",
  { detail: TrimmedNonEmptyString },
) {
  override get message(): string {
    return this.detail;
  }
}
