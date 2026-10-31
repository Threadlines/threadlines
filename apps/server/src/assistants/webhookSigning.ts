/**
 * Standard Webhooks signing (https://www.standardwebhooks.com), for alerts
 * sent to a web address: a receiver checks `webhook-signature` with the
 * target's `whsec_` secret, and drops a repeat by `webhook-id`.
 */
// @effect-diagnostics nodeBuiltinImport:off
import { createHmac } from "node:crypto";

/** Bytes in a signing secret. */
export const WEBHOOK_SECRET_BYTES = 32;

const SECRET_PREFIX = "whsec_";

/** A secret as the receiver pastes it: `whsec_` and its bytes in base64. */
export const formatWebhookSecret = (secret: Uint8Array) =>
  `${SECRET_PREFIX}${Buffer.from(secret).toString("base64")}`;

/** The bytes of a `whsec_` secret. */
export const parseWebhookSecret = (text: string) =>
  Buffer.from(text.startsWith(SECRET_PREFIX) ? text.slice(SECRET_PREFIX.length) : text, "base64");

/** `webhook-signature`'s value: `v1,` and the HMAC-SHA256 of `id.timestamp.body`. */
export const signWebhook = (input: {
  readonly secret: Uint8Array;
  readonly id: string;
  /** Seconds since the epoch, as sent in `webhook-timestamp`. */
  readonly timestamp: number;
  readonly body: string;
}) =>
  `v1,${createHmac("sha256", input.secret)
    .update(`${input.id}.${input.timestamp}.${input.body}`)
    .digest("base64")}`;

/** The headers every alert carries, besides the Authorization the user may add. */
export const webhookHeaders = (input: {
  readonly secret: Uint8Array;
  readonly id: string;
  readonly timestamp: number;
  readonly body: string;
}): Record<string, string> => ({
  "content-type": "application/json",
  "user-agent": "Threadlines",
  "webhook-id": input.id,
  "webhook-timestamp": String(input.timestamp),
  "webhook-signature": signWebhook(input),
});
