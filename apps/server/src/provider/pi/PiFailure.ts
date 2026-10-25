/**
 * PiFailure — a failed Pi turn's error text read into what the chat shows and
 * the category it reports.
 *
 * pi-ai prints a provider's HTTP status first (`401: {…}`, `401 {…}`,
 * `OpenAI API error (401): {…}`), or passes Google's error body on whole
 * (`{"error":{"code":401,…}}`), so the status is read from there with the
 * rule every driver shares. Pi's own wording covers the failures it raises
 * before any request: no key for the model's provider, or an account sign-in
 * it couldn't renew (expired, or no connection to the provider's sign-in). A provider that refused the key or sign-in, or one Pi has
 * none for, is said plainly with the way to fix it; anything else keeps
 * Pi's words.
 *
 * @module provider/pi/PiFailure
 */
import type { ProviderFailureCategory } from "@threadlines/contracts";

import { httpStatusFailureCategory } from "../providerFailureCategory.ts";
import { piProviderName } from "./PiProtocol.ts";

export interface PiTurnFailure {
  readonly message: string;
  readonly category?: ProviderFailureCategory;
}

/** Threadlines' own lead-in when Pi refuses the `prompt` request itself. */
export const PI_PROMPT_REFUSED_PREFIX = "Pi did not accept the message: ";

const SIGN_IN_HINT = "Sign in again from Settings → Pi → Sign in, then retry.";
/** For older wording that sounds like sign-in but carries no status. */
const GENERIC_SIGN_IN_HINT =
  "Sign in to Pi (Settings → Pi → Sign in, or run `pi` and type /login).";
const MAX_REASON_LENGTH = 200;

/** `401: {…}` and `401 {…}` (pi-ai, the Anthropic SDK), or `OpenAI API error (401): …`. */
const LEADING_STATUS = /^(\d{3})(?=[:\s])/u;
const PREFIXED_STATUS = /^[^\n(]{1,80}\((\d{3})\):/u;

/**
 * Pi's no-key wording, naming the provider when it can: `No API key found for
 * the selected model.`, `… for deepseek.`, `… for "deepseek"`, `No API key for
 * provider: deepseek`, `No API key provided for provider "deepseek"`.
 */
const NO_KEY =
  /^No API key (?:found |provided )?for (?:provider:?\s*)?(?:"([^"]+)"|the selected model|([^\s/."]+))/iu;
/** `OAuth refresh failed for x`, or `Authentication failed for "x". Credentials may have expired…`. */
const RENEWAL_FAILED =
  /^(?:OAuth refresh failed for\s+([^\s.:,"]+)|Authentication failed for "([^"]+)")/iu;
const LEGACY_SIGN_IN_WORDING =
  /no model|no api key|credentials|not authenticated|unauthorized|login/iu;

/** Google's SDK puts the whole error body in the message: `{"error":{"code":401,…}}`. */
function bodyStatus(text: string): number | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const code = (JSON.parse(text) as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === "number" && code >= 400 && code <= 599 ? code : undefined;
  } catch {
    return undefined;
  }
}

function statusOf(text: string): { readonly status: number; readonly rest: string } | undefined {
  const inBody = bodyStatus(text);
  if (inBody !== undefined) return { status: inBody, rest: text };
  const match = LEADING_STATUS.exec(text) ?? PREFIXED_STATUS.exec(text);
  if (!match) return undefined;
  return {
    status: Number(match[1]),
    rest: text
      .slice(match[0].length)
      .replace(/^[:\s]+/u, "")
      .trim(),
  };
}

/** The provider's own sentence from an error body: `message`, `error.message` or `error`. */
function bodyReason(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body.startsWith("{") ? undefined : body;
  }
  const record = typeof parsed === "object" && parsed !== null ? parsed : undefined;
  const pick = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const error = (record as { error?: unknown } | undefined)?.error;
  return (
    pick((record as { message?: unknown } | undefined)?.message) ??
    pick((error as { message?: unknown } | undefined)?.message) ??
    pick(error) ??
    pick((record as { detail?: unknown } | undefined)?.detail)
  );
}

const sentence = (text: string) => {
  const short =
    text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH - 1).trimEnd()}…` : text;
  return /[.!?…]$/u.test(short) ? short : `${short}.`;
};

/**
 * Reads a failed Pi turn. `provider` is the Pi provider id of the model the
 * turn ran on (`deepseek`), when known; Pi's own wording names it itself.
 */
export function piTurnFailure(
  failure: string | undefined,
  provider?: string | undefined,
): PiTurnFailure {
  const raw = failure?.trim();
  if (!raw) return { message: "Pi reported the turn failed." };
  const text = raw.startsWith(PI_PROMPT_REFUSED_PREFIX)
    ? raw.slice(PI_PROMPT_REFUSED_PREFIX.length).trim()
    : raw;
  const named = (id: string | undefined) => (id ? piProviderName(id) : undefined);

  const noKey = NO_KEY.exec(text);
  if (noKey) {
    const name = named(noKey[1] ?? noKey[2]) ?? named(provider);
    return {
      category: "auth",
      message: name
        ? `Pi has no key or sign-in for ${name}, which this chat's model needs. Sign in to ${name} from Settings → Pi → Sign in, or pick another model.`
        : `Pi has no key or sign-in for this chat's model. Sign in from Settings → Pi → Sign in, or pick another model.`,
    };
  }

  const renewalFailed = RENEWAL_FAILED.exec(text);
  if (renewalFailed) {
    const name = named(renewalFailed[1] ?? renewalFailed[2]) ?? named(provider) ?? "the provider";
    return {
      category: "auth",
      message: `Pi couldn't renew its sign-in to ${name}. Check that this computer can reach ${name}, or sign in again from Settings → Pi → Sign in, then retry.`,
    };
  }

  const status = statusOf(text);
  const category = httpStatusFailureCategory(status?.status);
  if (status && category === "auth") {
    const name = named(provider) ?? "The model's provider";
    const reason = status.rest ? bodyReason(status.rest) : undefined;
    return {
      category,
      message: `${name} rejected Pi's key or sign-in${reason ? `: ${sentence(reason)}` : "."} ${SIGN_IN_HINT}`,
    };
  }

  // A status that isn't 401 (a 403 refusing a region or plan) is not fixed by signing in.
  if (!status && LEGACY_SIGN_IN_WORDING.test(text)) {
    return {
      ...(category ? { category } : {}),
      message: `${raw} ${GENERIC_SIGN_IN_HINT}`,
    };
  }
  return { ...(category ? { category } : {}), message: raw };
}
