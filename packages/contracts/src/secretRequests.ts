import * as Schema from "effect/Schema";

import { SecretRequestId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Answering an agent's request for a key, sent to the thread's own computer
 * (docs/design/secret-requests.md, "Answering"). The value is wrapped so it
 * prints `<redacted>` wherever the decoded input is logged, and has no checks
 * on the wire: the server checks it and answers with fixed text, so a decode
 * error never quotes it.
 */
export const SecretRequestRespondInput = Schema.Struct({
  threadId: ThreadId,
  requestId: SecretRequestId,
  /** Made once per request by the app, and sent again on its retries. */
  claimId: TrimmedNonEmptyString,
  /** The app's device, as "Answered on <deviceLabel>" reads. */
  deviceLabel: TrimmedNonEmptyString,
  answer: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("save"),
      value: Schema.RedactedFromValue(Schema.String, { label: "secret" }),
    }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type SecretRequestRespondInput = typeof SecretRequestRespondInput.Type;
export type SecretRequestRespondEncoded = typeof SecretRequestRespondInput.Encoded;

/**
 * How the answer went. `rejected`: the use can't hold the value as typed, the
 * card stays and nothing was claimed. `by`: the device whose answer stands.
 */
export const SecretRequestAnswer = Schema.Struct({
  outcome: Schema.Literals([
    "saved",
    "failed",
    "uncertain",
    "declined",
    "rejected",
    "already_answered",
    "cancelled",
    "replaced",
    "gone",
  ]),
  detail: Schema.optional(TrimmedNonEmptyString),
  by: Schema.optional(TrimmedNonEmptyString),
});
export type SecretRequestAnswer = typeof SecretRequestAnswer.Type;

/** Remove now, on a saved `commands` key's row. */
export const SecretRequestRemoveInput = Schema.Struct({
  threadId: ThreadId,
  requestId: SecretRequestId,
});
export type SecretRequestRemoveInput = typeof SecretRequestRemoveInput.Type;

export class SecretRequestError extends Schema.TaggedError<SecretRequestError>()(
  "SecretRequestError",
  { detail: TrimmedNonEmptyString },
) {
  override get message(): string {
    return this.detail;
  }
}
