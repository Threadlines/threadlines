/**
 * Credentials for assistants (docs/design/assistants.md): always-on agents in
 * someone else's cloud that reach a user's computer through the relay's public
 * door. The computer mints and checks every one. The relay reads only the
 * routing part (host, connection, route tag) to know where a request goes, and
 * checks the route tag so a made-up credential never wakes a Durable Object.
 *
 *   tlac1.<hostId>.<connectionId>.<routeTag>.<secret>             authorization code (60 s)
 *   tlaa1.<hostId>.<connectionId>.<routeTag>.<rgen>.<exp>.<mac>   access token (1 h)
 *   tlar1.<hostId>.<connectionId>.<routeTag>.<rgen>.<mac>         refresh token (rotating)
 *   tlak1.<hostId>.<connectionId>.<routeTag>.<secret>             key (shown once)
 *
 * `rgen` is the refresh generation a token belongs to, `exp` the access
 * token's expiry in Unix seconds. `mac` and `secret` are 32 bytes, base64url.
 * The route tag is HMAC-SHA256 of the relay's route key over
 * `threadlines-assistant-route-v1|<hostId>|<connectionId>`, minted by the relay
 * when the computer makes the connection.
 *
 * Sign-in codes are what the app shows and the user types into the page the
 * assistant opened: 8 characters of Crockford base32 (40 bits), shown as
 * `K4D8-2PQX`.
 *
 * Pure strings and WebCrypto: runs in the relay worker and the server alike.
 */
import { fromBase64Url, toBase64Url, utf8 } from "./relaySecure.ts";

export type AssistantCredentialKind = "code" | "access" | "refresh" | "key";

export const ASSISTANT_CREDENTIAL_PREFIX: Readonly<Record<AssistantCredentialKind, string>> = {
  code: "tlac1",
  access: "tlaa1",
  refresh: "tlar1",
  key: "tlak1",
};

/** Where a credential's requests go: what the relay reads and checks. */
export interface AssistantRoute {
  readonly hostId: string;
  readonly connectionId: string;
  readonly routeTag: string;
}

export type AssistantCredential =
  | { readonly kind: "code"; readonly route: AssistantRoute; readonly secret: string }
  | {
      readonly kind: "access";
      readonly route: AssistantRoute;
      readonly generation: number;
      readonly expiresAtSeconds: number;
      readonly mac: string;
    }
  | {
      readonly kind: "refresh";
      readonly route: AssistantRoute;
      readonly generation: number;
      readonly mac: string;
    }
  | { readonly kind: "key"; readonly route: AssistantRoute; readonly secret: string };

/** Longest credential worth parsing; anything longer is junk. */
export const ASSISTANT_CREDENTIAL_MAX_LENGTH = 320;

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONNECTION_ID = /^[A-Za-z0-9-]{1,64}$/;
const B64_32 = /^[A-Za-z0-9_-]{43}$/;
const GENERATION = /^(0|[1-9][0-9]{0,8})$/;
const UNIX_SECONDS = /^[1-9][0-9]{9,10}$/;

const KIND_BY_PREFIX: ReadonlyMap<string, AssistantCredentialKind> = new Map(
  (Object.entries(ASSISTANT_CREDENTIAL_PREFIX) as Array<[AssistantCredentialKind, string]>).map(
    ([kind, prefix]) => [prefix, kind],
  ),
);

/** The credential's kind and parts, or null when it isn't one of ours. Checks shape only. */
export function parseAssistantCredential(raw: string): AssistantCredential | null {
  if (raw.length === 0 || raw.length > ASSISTANT_CREDENTIAL_MAX_LENGTH) return null;
  const parts = raw.split(".");
  const kind = KIND_BY_PREFIX.get(parts[0] ?? "");
  if (kind === undefined) return null;
  const [, hostId, connectionId, routeTag] = parts;
  if (hostId === undefined || !HOST_ID.test(hostId)) return null;
  if (connectionId === undefined || !CONNECTION_ID.test(connectionId)) return null;
  if (routeTag === undefined || !B64_32.test(routeTag)) return null;
  const route: AssistantRoute = { hostId, connectionId, routeTag };
  switch (kind) {
    case "code":
    case "key": {
      if (parts.length !== 5) return null;
      const secret = parts[4]!;
      return B64_32.test(secret) ? { kind, route, secret } : null;
    }
    case "access": {
      if (parts.length !== 7) return null;
      const [generation, expiresAt, mac] = [parts[4]!, parts[5]!, parts[6]!];
      if (!GENERATION.test(generation) || !UNIX_SECONDS.test(expiresAt) || !B64_32.test(mac)) {
        return null;
      }
      return {
        kind,
        route,
        generation: Number(generation),
        expiresAtSeconds: Number(expiresAt),
        mac,
      };
    }
    case "refresh": {
      if (parts.length !== 6) return null;
      const [generation, mac] = [parts[4]!, parts[5]!];
      if (!GENERATION.test(generation) || !B64_32.test(mac)) return null;
      return { kind, route, generation: Number(generation), mac };
    }
  }
}

/** Everything before the MAC: what the computer signs for an access or refresh token. */
export function assistantCredentialSigningInput(
  credential: Extract<AssistantCredential, { kind: "access" | "refresh" }>,
): string {
  const { hostId, connectionId, routeTag } = credential.route;
  const head = `${ASSISTANT_CREDENTIAL_PREFIX[credential.kind]}.${hostId}.${connectionId}.${routeTag}.${credential.generation}`;
  return credential.kind === "access" ? `${head}.${credential.expiresAtSeconds}` : head;
}

export function formatAssistantCredential(credential: AssistantCredential): string {
  switch (credential.kind) {
    case "code":
    case "key": {
      const { hostId, connectionId, routeTag } = credential.route;
      return `${ASSISTANT_CREDENTIAL_PREFIX[credential.kind]}.${hostId}.${connectionId}.${routeTag}.${credential.secret}`;
    }
    case "access":
    case "refresh":
      return `${assistantCredentialSigningInput(credential)}.${credential.mac}`;
  }
}

/** 32 random bytes, base64url: a code's or key's secret. */
export function randomAssistantSecret(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

// --- Route tags (the relay's) ---

export const ASSISTANT_ROUTE_TAG_LABEL = "threadlines-assistant-route-v1";

/** The relay's route key from its secret (base64url of at least 32 random bytes). */
export async function importAssistantRouteKey(secret: string): Promise<CryptoKey> {
  const raw = fromBase64Url(secret.trim());
  if (raw === null || raw.length < 32) {
    throw new Error("The assistant route key must be at least 32 bytes, base64url.");
  }
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function assistantRouteTag(
  key: CryptoKey,
  hostId: string,
  connectionId: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    utf8(`${ASSISTANT_ROUTE_TAG_LABEL}|${hostId}|${connectionId}`),
  );
  return toBase64Url(new Uint8Array(signature));
}

/** Whether a route's tag is the one the relay minted for its host and connection. Constant time. */
export async function verifyAssistantRouteTag(
  key: CryptoKey,
  route: AssistantRoute,
): Promise<boolean> {
  const tag = fromBase64Url(route.routeTag);
  if (tag === null || tag.length !== 32) return false;
  return crypto.subtle.verify(
    "HMAC",
    key,
    tag,
    utf8(`${ASSISTANT_ROUTE_TAG_LABEL}|${route.hostId}|${route.connectionId}`),
  );
}

// --- Sign-in codes (the app shows them; the page takes them) ---

/** Crockford base32: no I, L, O or U, so a code reads back the way it was typed. */
export const ASSISTANT_SIGN_IN_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ASSISTANT_SIGN_IN_CODE_LENGTH = 8;

/** A fresh code, 8 characters, no separator. Unbiased: 32 divides 256. */
export function generateAssistantSignInCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ASSISTANT_SIGN_IN_CODE_LENGTH));
  let code = "";
  for (const byte of bytes) code += ASSISTANT_SIGN_IN_CODE_ALPHABET[byte % 32];
  return code;
}

/** `K4D82PQX` as the app shows it: `K4D8-2PQX`. */
export function displayAssistantSignInCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * What the user typed as a code, or null when it can't be one. Case, spaces
 * and dashes don't matter; O reads as 0, and I or L as 1, as Crockford says.
 */
export function normalizeAssistantSignInCode(input: string): string | null {
  if (input.length > 32) return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (code.length !== ASSISTANT_SIGN_IN_CODE_LENGTH) return null;
  for (const char of code) {
    if (!ASSISTANT_SIGN_IN_CODE_ALPHABET.includes(char)) return null;
  }
  return code;
}
