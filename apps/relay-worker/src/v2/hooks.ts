import type { HookPayload } from "@threadlines/shared/relayHookSeal";
import { hmacSha256, randomBytes, toBase64Url, utf8 } from "@threadlines/shared/relaySecure";
import { isNeverKeptHeader, WEBHOOK_ALWAYS_KEPT_HEADERS } from "@threadlines/shared/webhookTasks";

import { timingSafeEqualString } from "../crypto.ts";

/**
 * Event tasks' public addresses (docs/design/event-tasks.md):
 * `/v2/hooks/{hostId}/{hookId}/{mac}`, where the mac is
 * `base64url(HMAC-SHA256(HOOK_PATH_KEY, "v1|" + hostId + "|" + hookId))`.
 * The worker checks it before anything touches a Durable Object, so a
 * made-up address can't wake or create one. `v1|` versions the key.
 */

const HOST_ID = /^[0-9a-f-]{36}$/u;
/** 16 random bytes. */
const HOOK_ID = /^[A-Za-z0-9_-]{22}$/u;
/** A SHA-256 HMAC. */
const HOOK_MAC = /^[A-Za-z0-9_-]{43}$/u;
/** An HTTP token, lowercase. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]{1,100}$/u;
const MAX_KEPT_HEADERS = 32;

export interface HookPath {
  readonly hostId: string;
  readonly hookId: string;
  readonly mac: string;
}

/** Splits a hook address the way the host object splits paths; null for anything else. */
export function parseHookPath(pathname: string): HookPath | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 5 || segments[0] !== "v2" || segments[1] !== "hooks") return null;
  const [, , hostId, hookId, mac] = segments as [string, string, string, string, string];
  return HOST_ID.test(hostId) && HOOK_ID.test(hookId) && HOOK_MAC.test(mac)
    ? { hostId, hookId, mac }
    : null;
}

export function isHookId(value: unknown): value is string {
  return typeof value === "string" && HOOK_ID.test(value);
}

export async function hookMac(key: string, hostId: string, hookId: string): Promise<string> {
  return toBase64Url(await hmacSha256(utf8(key), utf8(`v1|${hostId}|${hookId}`)));
}

/** Constant-time check of an address's mac. */
export async function verifyHookMac(key: string, path: HookPath): Promise<boolean> {
  return timingSafeEqualString(await hookMac(key, path.hostId, path.hookId), path.mac);
}

export function newHookId(): string {
  return toBase64Url(randomBytes(16));
}

export function hookUrl(origin: string, hostId: string, hookId: string, mac: string): string {
  return `${origin}/v2/hooks/${hostId}/${hookId}/${mac}`;
}

/**
 * A hook's extra kept headers as a host sends them: lowercase HTTP tokens,
 * at most 32, never one the relay must not keep (those are dropped). Null
 * for anything malformed.
 */
export function parseKeptHeaders(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_KEPT_HEADERS) return null;
  const names = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return null;
    const name = item.trim().toLowerCase();
    if (!HEADER_NAME.test(name)) return null;
    if (!isNeverKeptHeader(name)) names.add(name);
  }
  return [...names];
}

/** The headers a delivery keeps: the always-kept ones plus the hook's own, lowercased. */
export function keptHookHeaders(
  headers: Headers,
  extra: ReadonlyArray<string>,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of [...WEBHOOK_ALWAYS_KEPT_HEADERS, ...extra]) {
    if (isNeverKeptHeader(name)) continue;
    const value = headers.get(name);
    if (value !== null) kept[name.toLowerCase()] = value;
  }
  return kept;
}

/** One webhook request as it is sealed for the host. */
export function hookPayload(input: {
  readonly method: string;
  /** Without its `?`. */
  readonly query: string;
  readonly headers: Headers;
  readonly keptHeaders: ReadonlyArray<string>;
  readonly body: Uint8Array;
  readonly receivedAt: string;
}): HookPayload {
  return {
    method: input.method,
    query: input.query,
    headers: keptHookHeaders(input.headers, input.keptHeaders),
    body: input.body,
    receivedAt: input.receivedAt,
  };
}

/**
 * A delivery as the worker hands it to the host's object, body read in full.
 * Headers the relay never keeps are already left out; the object keeps only
 * the hook's own.
 */
export interface HookDeliveryInput {
  readonly hostId: string;
  readonly hookId: string;
  readonly method: string;
  readonly query: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Uint8Array;
}

export type HookDeliveryOutcome =
  | { readonly status: 202 | 404 }
  | {
      readonly status: 429;
      readonly reason: "daily-limit" | "queue-full";
      readonly retryAfterSeconds: number;
    };

export type BodyRead =
  | { readonly ok: true; readonly body: Uint8Array }
  | { readonly ok: false; readonly status: 400 | 408 | 413 };

/**
 * Reads a request body up to `maxBytes` within `deadlineMs`: a slow sender
 * gets 408, an oversized body 413 (whatever its Content-Length said), a
 * dropped one 400. Stops reading as soon as either limit is hit.
 */
export async function readCappedBody(
  body: ReadableStream<Uint8Array> | null,
  options: { readonly maxBytes: number; readonly deadlineMs: number },
): Promise<BodyRead> {
  if (!body) return { ok: true, body: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.deadlineMs);
  });
  const stop = () => {
    reader.cancel().catch(() => undefined);
  };
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === "timeout") {
        stop();
        return { ok: false, status: 408 };
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > options.maxBytes) {
        stop();
        return { ok: false, status: 413 };
      }
      chunks.push(next.value);
    }
  } catch {
    return { ok: false, status: 400 };
  } finally {
    clearTimeout(timer);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: out };
}
