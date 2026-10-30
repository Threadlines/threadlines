import { importAssistantRouteKey } from "@threadlines/shared/assistantCredentials";
import { fromBase64Url } from "@threadlines/shared/relaySecure";

import { ASSISTANT_MCP_PATH } from "@threadlines/contracts/relayAssistants";

import { publicRelayOrigin, type RelayV2Env } from "../env.ts";

/**
 * The assistants door (docs/design/assistants.md) as this deployment has it
 * set up: its public origin, its kill switch and its two permanent secrets.
 * The door is on only when all of them are there; otherwise every assistant
 * route answers 503 and the host's info says `enabled: false`.
 */
export type AssistantsConfig =
  | {
      readonly enabled: true;
      /** `https://connect.threadlines.dev`, no trailing slash. */
      readonly origin: string;
      /** `<origin>/mcp`: the protected resource, and the address users paste. */
      readonly resource: string;
      /** Whether the origin is loopback http (local `wrangler dev`): loopback redirects are allowed then. */
      readonly loopback: boolean;
      readonly routeKey: CryptoKey;
      readonly clientKey: CryptoKey;
      /** Requests each computer forwards per UTC day. */
      readonly dailyRequests: number;
    }
  | {
      readonly enabled: false;
      /** The configured origin when it is valid, for the info route's address. */
      readonly origin: string | null;
    };

export const DEFAULT_ASSISTANT_DAILY_REQUESTS = 20_000;
/** Host routes' error code while the door is off (like `hooks-off`). */
export const ASSISTANTS_OFF_CODE = "assistants-off";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Keys imported once per isolate: HMAC keys don't change between requests. */
const keyCache = new Map<string, Promise<CryptoKey>>();

export async function assistantsConfig(env: RelayV2Env): Promise<AssistantsConfig> {
  const origin = assistantsOrigin(env.ASSISTANTS_ORIGIN);
  const switchedOn = isOn(env.ASSISTANTS_ENABLED);
  const routeSecret = env.ASSISTANT_ROUTE_KEY?.trim() ?? "";
  const clientSecret = env.ASSISTANT_CLIENT_KEY?.trim() ?? "";
  if (!origin || !switchedOn || !isKeySecret(routeSecret) || !isKeySecret(clientSecret)) {
    return { enabled: false, origin: origin?.origin ?? null };
  }
  return {
    enabled: true,
    origin: origin.origin,
    resource: `${origin.origin}/mcp`,
    loopback: origin.loopback,
    routeKey: await cachedKey(`route:${routeSecret}`, () => importAssistantRouteKey(routeSecret)),
    clientKey: await cachedKey(`client:${clientSecret}`, () =>
      importAssistantClientKey(clientSecret),
    ),
    dailyRequests: positiveInt(
      env.THREADLINES_RELAY_HOST_DAILY_ASSISTANT_REQUESTS,
      DEFAULT_ASSISTANT_DAILY_REQUESTS,
    ),
  };
}

/**
 * The configured origin, or null when it can't be one: https, or plain http
 * only for loopback (a local relay). No path, query or credentials.
 */
export function assistantsOrigin(
  value: string | undefined,
): { readonly origin: string; readonly loopback: boolean } | null {
  const text = value?.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol === "https:") return { origin: url.origin, loopback: false };
  if (url.protocol === "http:" && loopback) return { origin: url.origin, loopback: true };
  return null;
}

/** Whether a host name is loopback, as allowed for redirects only while the door itself is. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

/** The key that signs registered clients' ids. Domain separated from the route key by its label. */
export async function importAssistantClientKey(secret: string): Promise<CryptoKey> {
  const raw = fromBase64Url(secret.trim());
  if (raw === null || raw.length < 32) {
    throw new Error("The assistant client key must be at least 32 bytes, base64url.");
  }
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function isKeySecret(secret: string): boolean {
  const raw = fromBase64Url(secret);
  return raw !== null && raw.length >= 32;
}

function cachedKey(id: string, load: () => Promise<CryptoKey>): Promise<CryptoKey> {
  let key = keyCache.get(id);
  if (!key) {
    key = load();
    keyCache.set(id, key);
    key.catch(() => keyCache.delete(id));
  }
  return key;
}

/** The kill switch: `false`/`0`/`off` turns the door off, like the relay's other switches. */
function isOn(value: string | undefined): boolean {
  const configured = value?.trim().toLowerCase();
  return configured !== "false" && configured !== "0" && configured !== "off";
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * The address to paste and whether the door is on. The same for every
 * computer, so it's also public (`GET /v2/assistants`): a computer shows it
 * in Settings before it has registered with the relay.
 */
export async function assistantsInfo(
  request: Request,
  env: RelayV2Env,
): Promise<{ readonly address: string; readonly enabled: boolean }> {
  const config = await assistantsConfig(env);
  const origin = config.origin ?? publicRelayOrigin(request, env);
  return { address: `${origin}${ASSISTANT_MCP_PATH}`, enabled: config.enabled };
}
