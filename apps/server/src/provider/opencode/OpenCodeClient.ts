/**
 * OpenCodeClient — the OpenCode 2 HTTP client, wrapped for Effect.
 *
 * Uses the zero-Effect Promise entry of `@opencode/client`. Its Effect entry
 * pins a different Effect release than this repo, and two Effect copies in one
 * process break schema decoding; the Promise entry imports no Effect at all.
 * The trade is that responses are not validated, so callers read them
 * defensively and the event stream is decoded here, in `OpenCodeEvents`.
 *
 * @module provider/opencode/OpenCodeClient
 */
import { OpenCode, type OpenCodeClient as RawOpenCodeClient } from "@opencode/client";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as P from "effect/Predicate";

export type OpenCodeClient = RawOpenCodeClient;

const OPENCODE_ERROR_TAG = "OpenCodeError";

/** Any failure talking to OpenCode: transport, HTTP status, or a declared API error. */
export class OpenCodeError extends Data.TaggedError(OPENCODE_ERROR_TAG)<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  static readonly is = (u: unknown): u is OpenCodeError => P.isTagged(u, OPENCODE_ERROR_TAG);

  override get message(): string {
    return `${this.operation}: ${this.detail}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Declared API errors arrive as their JSON body (`{_tag, message, ...}`);
 * everything else is a `ClientError` or a plain `Error`.
 */
export function openCodeErrorDetail(cause: unknown): string {
  if (OpenCodeError.is(cause)) return cause.detail;
  if (isRecord(cause) && typeof cause._tag === "string") {
    const message = typeof cause.message === "string" ? cause.message.trim() : "";
    return message.length > 0 ? `${cause._tag}: ${message}` : cause._tag;
  }
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  return String(cause);
}

/** The declared `_tag` of an API error body, if the failure was one. */
export function openCodeErrorTag(cause: unknown): string | undefined {
  const inner = OpenCodeError.is(cause) ? cause.cause : cause;
  return isRecord(inner) && typeof inner._tag === "string" ? inner._tag : undefined;
}

/** HTTP status of a `ClientError("UnexpectedStatus")`, if the failure was one. */
export function openCodeErrorStatus(cause: unknown): number | undefined {
  const inner = OpenCodeError.is(cause) ? cause.cause : cause;
  if (!(inner instanceof Error) || !isRecord(inner.cause)) return undefined;
  return typeof inner.cause.status === "number" ? inner.cause.status : undefined;
}

export const runOpenCode = <A>(
  operation: string,
  fn: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, OpenCodeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) => new OpenCodeError({ operation, detail: openCodeErrorDetail(cause), cause }),
  });

/**
 * HTTP Basic credentials. The username is always `opencode`; the password is
 * encoded as UTF-8 (the platform `btoa`/Latin-1 path mangles non-ASCII).
 */
export function openCodeAuthorization(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
}

export function makeOpenCodeClient(input: {
  readonly url: string;
  readonly password: string | undefined;
}): OpenCodeClient {
  return OpenCode.make({
    baseUrl: input.url,
    headers: {
      ...(input.password ? { authorization: openCodeAuthorization(input.password) } : {}),
      "x-opencode-client": "threadlines",
    },
  });
}

/**
 * A model reference on the wire. Threadlines slugs are `provider/model`, split
 * at the first slash (`openrouter/deepseek/x` is provider `openrouter`).
 */
export interface OpenCodeModelRef {
  readonly providerID: string;
  readonly id: string;
  readonly variant?: string;
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): { readonly providerID: string; readonly id: string } | undefined {
  const trimmed = slug?.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { providerID: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

export function openCodeModelSlug(ref: { readonly providerID: string; readonly id: string }) {
  return `${ref.providerID}/${ref.id}`;
}
