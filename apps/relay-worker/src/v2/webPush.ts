// @effect-diagnostics globalDate:off
/**
 * Sending a sealed alert to a phone's push service (RFC 8030), signed with
 * the relay's VAPID key (RFC 8292). The relay holds the only private key a
 * phone's subscription accepts, so a computer can reach a phone only through
 * the relay, and only while that phone is still paired with it. The payload
 * arrives already sealed for the phone (RFC 8291); the relay never reads it.
 */
import {
  RELAY_PUSH_MAX_PAYLOAD_BYTES,
  RELAY_PUSH_MAX_TTL_SECONDS,
} from "@threadlines/contracts/relay";

import { base64UrlDecode, base64UrlEncode, sha256Base64Url } from "../crypto.ts";

/**
 * Push services a phone's browser subscribes with. An endpoint anywhere else
 * is refused, so the relay can't be pointed at an arbitrary address.
 */
const PUSH_SERVICE_HOSTS: ReadonlyArray<RegExp> = [
  // Apple documents its senders' hosts as *.push.apple.com.
  /^(?:[a-z0-9-]+\.)*push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];
const MAX_ENDPOINT_LENGTH = 1024;
/** What a push service takes in one message (RFC 8030 §7.2 minimum is 4096). */
export const MAX_PUSH_PAYLOAD_BYTES = RELAY_PUSH_MAX_PAYLOAD_BYTES;
/** Alerts are worth little late: an hour at most. */
export const MAX_PUSH_TTL_SECONDS = RELAY_PUSH_MAX_TTL_SECONDS;
/** VAPID tokens may live up to a day; half that leaves room for clock skew. */
const VAPID_TOKEN_SECONDS = 12 * 60 * 60;
const VAPID_SUBJECT = "https://threadlines.dev";

/** The endpoint as a URL when it is one the relay sends to, else null. */
export function checkPushEndpoint(endpoint: string): URL | null {
  if (endpoint.length > MAX_ENDPOINT_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  return PUSH_SERVICE_HOSTS.some((host) => host.test(url.hostname)) ? url : null;
}

export interface VapidKey {
  /** Names the key a subscription was made with, so a rotation can tell them apart. */
  readonly keyId: string;
  /** Uncompressed P-256 point, base64url: the `applicationServerKey` phones subscribe with. */
  readonly publicKey: string;
  readonly privateKey: CryptoKey;
}

/** The hosted channels a phone's app can be on; each subscribes with its own key. */
export const PUSH_KEY_CHANNELS = ["stable", "nightly"] as const;
export type PushKeyChannel = (typeof PUSH_KEY_CHANNELS)[number];

export interface VapidKeyring {
  /** The key each channel's phones subscribe with now. */
  readonly byChannel: ReadonlyMap<PushKeyChannel, VapidKey>;
  /** Every key the relay still signs with, retired ones included. */
  readonly byKeyId: ReadonlyMap<string, VapidKey>;
}

async function importVapidJwk(jwk: unknown): Promise<VapidKey | null> {
  if (typeof jwk !== "object" || jwk === null) return null;
  const { kty, crv, x, y, d } = jwk as Record<string, unknown>;
  if (kty !== "EC" || crv !== "P-256") return null;
  if (typeof x !== "string" || typeof y !== "string" || typeof d !== "string") return null;
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { kty, crv, x, y, d },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const point = new Uint8Array(65);
  point[0] = 0x04;
  point.set(base64UrlDecode(x), 1);
  point.set(base64UrlDecode(y), 33);
  const publicKey = base64UrlEncode(point);
  return { keyId: (await sha256Base64Url(publicKey)).slice(0, 12), publicKey, privateKey };
}

/**
 * The relay's keys from its secret: `{ "stable": <jwk>, "nightly": <jwk>,
 * "retired": [<jwk>, ...] }`, P-256 private JWKs. Null when the secret is
 * unset or unreadable (the relay then sends no alerts). Rotating a channel's
 * key means moving the old one to `retired`, so phones subscribed with it
 * keep getting alerts until they subscribe again.
 */
export async function importVapidKeyring(secret: string | undefined): Promise<VapidKeyring | null> {
  if (!secret) return null;
  try {
    const parsed = JSON.parse(secret) as Record<string, unknown>;
    const byChannel = new Map<PushKeyChannel, VapidKey>();
    const byKeyId = new Map<string, VapidKey>();
    for (const channel of PUSH_KEY_CHANNELS) {
      const key = await importVapidJwk(parsed[channel]);
      if (!key) continue;
      byChannel.set(channel, key);
      byKeyId.set(key.keyId, key);
    }
    for (const jwk of Array.isArray(parsed.retired) ? parsed.retired : []) {
      const key = await importVapidJwk(jwk);
      if (key) byKeyId.set(key.keyId, key);
    }
    return byKeyId.size > 0 ? { byChannel, byKeyId } : null;
  } catch {
    return null;
  }
}

const encodeJson = (value: unknown) =>
  base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

/** A signed token stays in use until this little of its life is left. */
const VAPID_TOKEN_RENEW_BEFORE_SECONDS = 60 * 60;

/**
 * Reuses one signed token per key and push service while it has more than an
 * hour left (Apple asks senders not to sign new ones more often than hourly).
 */
export function makeVapidAuthorizer() {
  const cache = new Map<string, { readonly header: string; readonly expiresAtMs: number }>();
  return async (key: VapidKey, endpoint: URL, nowMs: number): Promise<string> => {
    const cacheKey = `${key.keyId} ${endpoint.origin}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAtMs - nowMs > VAPID_TOKEN_RENEW_BEFORE_SECONDS * 1000) {
      return cached.header;
    }
    const header = await vapidAuthorization(key, endpoint, nowMs);
    cache.set(cacheKey, { header, expiresAtMs: nowMs + VAPID_TOKEN_SECONDS * 1000 });
    return header;
  };
}

/** The `Authorization` header value for one push to `endpoint` (RFC 8292 §3). */
export async function vapidAuthorization(
  key: VapidKey,
  endpoint: URL,
  nowMs: number,
): Promise<string> {
  const signingInput = `${encodeJson({ typ: "JWT", alg: "ES256" })}.${encodeJson({
    aud: endpoint.origin,
    exp: Math.floor(nowMs / 1000) + VAPID_TOKEN_SECONDS,
    sub: VAPID_SUBJECT,
  })}`;
  // WebCrypto's ECDSA signature is r || s, which is what JWS ES256 wants.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `vapid t=${signingInput}.${base64UrlEncode(new Uint8Array(signature))}, k=${key.publicKey}`;
}

export type PushUrgency = "very-low" | "low" | "normal" | "high";

export interface PushMessage {
  /** RFC 8291 aes128gcm body, already sealed for the phone. */
  readonly payload: Uint8Array<ArrayBuffer>;
  readonly ttlSeconds: number;
  readonly urgency: PushUrgency;
  /** A later message with the same topic replaces an undelivered one (RFC 8030 §5.4). */
  readonly topic?: string | undefined;
}

export function pushRequestInit(message: PushMessage, authorization: string): RequestInit {
  const headers: Record<string, string> = {
    Authorization: authorization,
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(Math.max(0, Math.min(MAX_PUSH_TTL_SECONDS, Math.floor(message.ttlSeconds)))),
    Urgency: message.urgency,
  };
  if (message.topic) headers.Topic = message.topic;
  return { method: "POST", headers, body: message.payload };
}

/**
 * What a push service's answer means for the sender: delivered; the phone
 * dropped the subscription (forget it); the message itself is wrong (don't
 * resend it); or try again later.
 */
export type PushOutcome = "sent" | "gone" | "rejected" | "retry";

export function classifyPushResponse(status: number): PushOutcome {
  if (status >= 200 && status < 300) return "sent";
  if (status === 404 || status === 410) return "gone";
  if (status === 429 || status >= 500) return "retry";
  return "rejected";
}

let loadedKeyring: {
  readonly secret: string;
  readonly keyring: Promise<VapidKeyring | null>;
} | null = null;

/** The keyring for this isolate, imported once per secret value. */
export function loadVapidKeyring(secret: string | undefined): Promise<VapidKeyring | null> {
  if (!secret) return Promise.resolve(null);
  if (loadedKeyring?.secret !== secret) {
    loadedKeyring = { secret, keyring: importVapidKeyring(secret) };
  }
  return loadedKeyring.keyring;
}

// ----- request bodies ------------------------------------------------------------

const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Largest body either push route reads; anything bigger is refused unread. */
export const MAX_PUSH_REQUEST_BYTES = 8 * 1024;

const textField = (value: unknown, min: number, max: number): string | null =>
  typeof value === "string" && value.length >= min && value.length <= max && BASE64URL.test(value)
    ? value
    : null;

export interface DevicePushBody {
  readonly registrationId: string;
  readonly endpoint: URL;
  readonly keyId: string;
  readonly kinds: {
    readonly needs_you: boolean;
    readonly finished: boolean;
    readonly failed: boolean;
  };
}

/** `PUT .../devices/{d}/push` (RelayDevicePushInput), or null when anything is off. */
export function parseDevicePushBody(body: unknown): DevicePushBody | null {
  if (typeof body !== "object" || body === null) return null;
  const fields = body as Record<string, unknown>;
  const registrationId = textField(fields.registrationId, 8, 64);
  const keyId = textField(fields.keyId, 1, 32);
  const endpoint = typeof fields.endpoint === "string" ? checkPushEndpoint(fields.endpoint) : null;
  const kinds = fields.kinds as Record<string, unknown> | null | undefined;
  if (!registrationId || !keyId || !endpoint || typeof kinds !== "object" || kinds === null) {
    return null;
  }
  const { needs_you, finished, failed } = kinds;
  if (
    typeof needs_you !== "boolean" ||
    typeof finished !== "boolean" ||
    typeof failed !== "boolean"
  ) {
    return null;
  }
  return { registrationId, endpoint, keyId, kinds: { needs_you, finished, failed } };
}

export interface DeviceAlertBody {
  readonly registrationId: string;
  readonly kind: "needs_you" | "finished" | "failed" | "test";
  readonly message: PushMessage;
}

const ALERT_KINDS = new Set(["needs_you", "finished", "failed", "test"]);
const URGENCIES = new Set(["very-low", "low", "normal", "high"]);

/** `POST .../devices/{d}/alert` (RelayDeviceAlertInput), or null when anything is off. */
export function parseDeviceAlertBody(body: unknown): DeviceAlertBody | null {
  if (typeof body !== "object" || body === null) return null;
  const fields = body as Record<string, unknown>;
  const registrationId = textField(fields.registrationId, 8, 64);
  const encoded = textField(fields.payload, 1, Math.ceil((MAX_PUSH_PAYLOAD_BYTES * 4) / 3));
  const ttl = fields.ttlSeconds;
  const topic = fields.topic === undefined ? undefined : textField(fields.topic, 1, 32);
  if (
    !registrationId ||
    !encoded ||
    typeof fields.kind !== "string" ||
    !ALERT_KINDS.has(fields.kind) ||
    typeof fields.urgency !== "string" ||
    !URGENCIES.has(fields.urgency) ||
    typeof ttl !== "number" ||
    !Number.isInteger(ttl) ||
    ttl < 0 ||
    ttl > MAX_PUSH_TTL_SECONDS ||
    topic === null
  ) {
    return null;
  }
  let payload: Uint8Array<ArrayBuffer>;
  try {
    payload = base64UrlDecode(encoded);
  } catch {
    return null;
  }
  if (payload.length > MAX_PUSH_PAYLOAD_BYTES) return null;
  return {
    registrationId,
    kind: fields.kind as DeviceAlertBody["kind"],
    message: { payload, ttlSeconds: ttl, urgency: fields.urgency as PushUrgency, topic },
  };
}

/** The request's JSON body, or null when it is missing, malformed or larger than `maxBytes`. */
export async function readCappedJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
