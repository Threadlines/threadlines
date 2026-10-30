// @effect-diagnostics globalDate:off
import type { RelayAssistantClientIdentity } from "@threadlines/contracts/relayAssistants";
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "@threadlines/shared/relaySecure";

import { readCappedBody } from "../hooks.ts";
import { isLoopbackHost } from "./config.ts";

/**
 * Who is signing in (docs/design/assistants.md, "Clients"). Two kinds:
 *
 * - **Registered** (stateless DCR): `POST /register` hands back a client id
 *   that is itself the registration, signed with `ASSISTANT_CLIENT_KEY`:
 *   `tlrc1.<base64url JSON>.<mac>`. Nothing is stored. Its name is its own
 *   claim, and its identity is where its sign-in returns to.
 * - **CIMD**: the client id is an https URL whose metadata document the relay
 *   fetches (no redirects, 5 KiB, 10 s, cached an hour). Its identity is that
 *   URL's host, which the fetch proves.
 */
export interface AssistantClient {
  readonly clientId: string;
  readonly kind: "cimd" | "registered";
  readonly name: string;
  readonly redirectUris: ReadonlyArray<string>;
  readonly softwareId: string | null;
  /** CIMD: the client id URL's host. */
  readonly cimdHost: string | null;
}

export type ClientResolution =
  | { readonly ok: true; readonly client: AssistantClient }
  | { readonly ok: false; readonly reason: string };

export const CLIENT_NAME_MAX_LENGTH = 60;
export const REDIRECT_URI_MAX_LENGTH = 512;
export const MAX_REDIRECT_URIS = 5;
const SOFTWARE_ID_MAX_LENGTH = 100;
/** A registered client id longer than this is refused (it rides in every sign-in URL). */
const REGISTERED_CLIENT_ID_MAX_LENGTH = 4096;
const REGISTERED_PREFIX = "tlrc1";
const CLIENT_MAC_LABEL = "threadlines-assistant-client-v1";

const CIMD_MAX_BYTES = 5 * 1024;
const CIMD_FETCH_MS = 10_000;
const CIMD_CACHE_MS = 60 * 60_000;
const CIMD_CACHE_ENTRIES = 256;
/** A metadata document may list more return addresses than a registration; only the usable ones are kept. */
const CIMD_MAX_LISTED_REDIRECTS = 20;
const CIMD_MAX_KEPT_REDIRECTS = 10;

/**
 * Return sites of assistants we know (Cursor's, OpenAI's, Anthropic's, Meta's,
 * xAI's). A hint for the approval dialog, never a gate: a client that isn't
 * here still connects, and the dialog warns that Threadlines doesn't know it.
 */
const KNOWN_ASSISTANT_HOSTS = [
  "cursor.com",
  "cursor.sh",
  "chatgpt.com",
  "openai.com",
  "claude.ai",
  "claude.com",
  "anthropic.com",
  "meta.ai",
  "x.ai",
  "grok.com",
] as const;

export function isKnownAssistantHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return KNOWN_ASSISTANT_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

/** The dialog's facts about who is signing in, for one sign-in returning to `redirectUri`. */
export function clientIdentity(
  client: AssistantClient,
  redirectUri: string,
): RelayAssistantClientIdentity {
  if (client.kind === "cimd" && client.cimdHost) {
    return { kind: "cimd", host: client.cimdHost, known: isKnownAssistantHost(client.cimdHost) };
  }
  const redirect = new URL(redirectUri);
  return {
    kind: "registered",
    host: redirect.host,
    known: isKnownAssistantHost(redirect.hostname),
  };
}

/**
 * A return address as registered, or null. https only, exact (kept as sent,
 * compared as sent), no userinfo or fragment, printable ASCII, at most 512
 * characters. Loopback http (127.0.0.1, [::1], localhost) when allowed: the
 * door allows it, as the MCP spec says, for native clients.
 */
export function checkRedirectUri(value: unknown, allowLoopbackHttp: boolean): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > REDIRECT_URI_MAX_LENGTH || !/^[\x21-\x7e]+$/u.test(value)) return null;
  if (value.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || !url.hostname) return null;
  if (url.protocol === "https:") return value;
  if (url.protocol === "http:" && allowLoopbackHttp && isLoopbackHost(url.hostname)) return value;
  return null;
}

/** A client's name as shown: no control or formatting characters, spaces collapsed, 60 characters. */
export function cleanClientName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return null;
  const characters = [...cleaned];
  return characters.length <= CLIENT_NAME_MAX_LENGTH
    ? cleaned
    : characters.slice(0, CLIENT_NAME_MAX_LENGTH).join("").trimEnd();
}

// ----- registered clients (stateless DCR) ------------------------------------

/** What `POST /register` accepts, already checked. */
export interface ClientRegistration {
  readonly name: string;
  readonly redirectUris: ReadonlyArray<string>;
  readonly softwareId: string | null;
}

export type RegistrationParse =
  | { readonly ok: true; readonly registration: ClientRegistration }
  | {
      readonly ok: false;
      readonly error: "invalid_redirect_uri" | "invalid_client_metadata";
      readonly description: string;
    };

/** RFC 7591 metadata as a public client sends it. Only what a public, code-flow client may ask for. */
export function parseRegistration(body: unknown, allowLoopbackHttp: boolean): RegistrationParse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return metadataError("Send the client metadata as a JSON object.");
  }
  const metadata = body as Record<string, unknown>;
  const uris = metadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
      description: `Register between 1 and ${MAX_REDIRECT_URIS} redirect URIs.`,
    };
  }
  const redirectUris: string[] = [];
  for (const uri of uris) {
    const checked = checkRedirectUri(uri, allowLoopbackHttp);
    if (checked === null) {
      return {
        ok: false,
        error: "invalid_redirect_uri",
        description:
          "Redirect URIs must be https, at most 512 characters, with no user info or fragment.",
      };
    }
    if (!redirectUris.includes(checked)) redirectUris.push(checked);
  }
  const authMethod = metadata.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== "none") {
    return metadataError("Only public clients can register: token_endpoint_auth_method none.");
  }
  if (!isSubsetOf(metadata.grant_types, ["authorization_code", "refresh_token"])) {
    return metadataError("Only the authorization_code and refresh_token grants are supported.");
  }
  if (!isSubsetOf(metadata.response_types, ["code"])) {
    return metadataError("Only the code response type is supported.");
  }
  const softwareId = metadata.software_id;
  if (
    softwareId !== undefined &&
    (typeof softwareId !== "string" ||
      softwareId.length > SOFTWARE_ID_MAX_LENGTH ||
      !/^[\x20-\x7e]*$/u.test(softwareId))
  ) {
    return metadataError("software_id must be a short printable string.");
  }
  const name = cleanClientName(metadata.client_name) ?? new URL(redirectUris[0]!).host;
  return {
    ok: true,
    registration: {
      name,
      redirectUris,
      softwareId: typeof softwareId === "string" && softwareId.trim() ? softwareId.trim() : null,
    },
  };
}

/** The client id for a registration: the registration itself, signed. */
export async function signRegisteredClientId(
  key: CryptoKey,
  registration: ClientRegistration,
  issuedAtSeconds: number,
): Promise<string | null> {
  const payload = toBase64Url(
    utf8(
      JSON.stringify({
        v: 1,
        n: registration.name,
        r: registration.redirectUris,
        ...(registration.softwareId ? { s: registration.softwareId } : {}),
        t: issuedAtSeconds,
      }),
    ),
  );
  const mac = toBase64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(`${CLIENT_MAC_LABEL}|${payload}`))),
  );
  const clientId = `${REGISTERED_PREFIX}.${payload}.${mac}`;
  return clientId.length <= REGISTERED_CLIENT_ID_MAX_LENGTH ? clientId : null;
}

/** A registered client from its id, or null when the id isn't one the relay signed. */
export async function verifyRegisteredClientId(
  key: CryptoKey,
  clientId: string,
  allowLoopbackHttp: boolean,
): Promise<AssistantClient | null> {
  if (clientId.length > REGISTERED_CLIENT_ID_MAX_LENGTH) return null;
  const parts = clientId.split(".");
  if (parts.length !== 3 || parts[0] !== REGISTERED_PREFIX) return null;
  const [, payload, macText] = parts as [string, string, string];
  const mac = fromBase64Url(macText);
  if (!payload || mac === null || mac.length !== 32) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    mac,
    utf8(`${CLIENT_MAC_LABEL}|${payload}`),
  );
  if (!valid) return null;
  const bytes = fromBase64Url(payload);
  if (bytes === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(fromUtf8(bytes));
  } catch {
    return null;
  }
  const fields = decoded as { v?: unknown; n?: unknown; r?: unknown; s?: unknown };
  const name = cleanClientName(fields.n);
  const uris = Array.isArray(fields.r)
    ? fields.r.map((uri) => checkRedirectUri(uri, allowLoopbackHttp))
    : [];
  if (fields.v !== 1 || !name || uris.length === 0 || uris.some((uri) => uri === null)) {
    return null;
  }
  return {
    clientId,
    kind: "registered",
    name,
    redirectUris: uris as string[],
    softwareId: typeof fields.s === "string" ? fields.s : null,
    cimdHost: null,
  };
}

// ----- CIMD (client ID metadata documents) -----------------------------------

const cimdCache = new Map<
  string,
  { readonly expiresAt: number; readonly client: AssistantClient }
>();

/** Forgets cached metadata documents (tests). */
export function clearClientMetadataCache(): void {
  cimdCache.clear();
}

export function isMetadataDocumentClientId(clientId: string): boolean {
  return clientId.startsWith("https://");
}

/**
 * A metadata document's URL, or null. Canonical https with a path, a DNS name
 * (never an IP literal or a local name), no port, userinfo or fragment. The
 * relay fetches it from Cloudflare's network, which can't reach private
 * addresses; refusing literals and local names keeps it from trying.
 */
export function checkMetadataDocumentUrl(clientId: string): URL | null {
  if (clientId.length > REDIRECT_URI_MAX_LENGTH || !/^[\x21-\x7e]+$/u.test(clientId)) return null;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.href !== clientId) return null;
  if (url.username || url.password || url.port || url.hash) return null;
  if (url.pathname === "/" || url.pathname === "") return null;
  const host = url.hostname;
  if (host.startsWith("[") || /^[0-9.]+$/u.test(host) || !host.includes(".")) return null;
  if (/(^|\.)(localhost|local|internal|home\.arpa)$/u.test(host)) return null;
  return url;
}

export interface ClientResolveOptions {
  readonly clientKey: CryptoKey;
  readonly allowLoopbackHttp: boolean;
  readonly fetch?: typeof fetch;
  readonly now?: number;
}

/** The client behind a client id, either kind. */
export async function resolveClient(
  clientId: string,
  options: ClientResolveOptions,
): Promise<ClientResolution> {
  if (isMetadataDocumentClientId(clientId)) return resolveMetadataDocument(clientId, options);
  const client = await verifyRegisteredClientId(
    options.clientKey,
    clientId,
    options.allowLoopbackHttp,
  );
  return client
    ? { ok: true, client }
    : { ok: false, reason: "This assistant's client id isn't valid. Start again from it." };
}

async function resolveMetadataDocument(
  clientId: string,
  options: ClientResolveOptions,
): Promise<ClientResolution> {
  const now = options.now ?? Date.now();
  const cached = cimdCache.get(clientId);
  if (cached && cached.expiresAt > now) return { ok: true, client: cached.client };
  const url = checkMetadataDocumentUrl(clientId);
  const refused = (reason: string): ClientResolution => ({ ok: false, reason });
  if (!url) return refused("This assistant's client id isn't an address Threadlines can check.");

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url.href, {
      method: "GET",
      headers: { accept: "application/json" },
      // A redirect would move the identity to an address nobody checked.
      redirect: "manual",
      signal: AbortSignal.timeout(CIMD_FETCH_MS),
    });
  } catch {
    return refused("Threadlines couldn't reach this assistant's client details.");
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return refused(
      response.status >= 300 && response.status < 400
        ? "This assistant's client details redirect somewhere else, which Threadlines doesn't follow."
        : "Threadlines couldn't get this assistant's client details.",
    );
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > CIMD_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return refused("This assistant's client details are too large.");
  }
  const read = await readCappedBody(response.body, {
    maxBytes: CIMD_MAX_BYTES,
    deadlineMs: CIMD_FETCH_MS,
  });
  if (!read.ok) return refused("Threadlines couldn't read this assistant's client details.");
  let document: unknown;
  try {
    document = JSON.parse(fromUtf8(read.body));
  } catch {
    return refused("This assistant's client details aren't valid JSON.");
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return refused("This assistant's client details aren't valid.");
  }
  const metadata = document as Record<string, unknown>;
  if (metadata.client_id !== clientId) {
    return refused("This assistant's client details are for a different client.");
  }
  const authMethod = metadata.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== "none") {
    return refused("This assistant signs in a way Threadlines doesn't support.");
  }
  const listed = Array.isArray(metadata.redirect_uris)
    ? metadata.redirect_uris.slice(0, CIMD_MAX_LISTED_REDIRECTS)
    : [];
  const redirectUris: string[] = [];
  for (const uri of listed) {
    const checked = checkRedirectUri(uri, options.allowLoopbackHttp);
    if (checked && !redirectUris.includes(checked)) redirectUris.push(checked);
    if (redirectUris.length === CIMD_MAX_KEPT_REDIRECTS) break;
  }
  if (redirectUris.length === 0) {
    return refused("This assistant's client details have no https return address.");
  }
  const client: AssistantClient = {
    clientId,
    kind: "cimd",
    name: cleanClientName(metadata.client_name) ?? url.hostname,
    redirectUris,
    softwareId: typeof metadata.software_id === "string" ? metadata.software_id : null,
    cimdHost: url.hostname,
  };
  if (cimdCache.size >= CIMD_CACHE_ENTRIES) {
    const oldest = cimdCache.keys().next().value;
    if (oldest !== undefined) cimdCache.delete(oldest);
  }
  cimdCache.set(clientId, { expiresAt: now + CIMD_CACHE_MS, client });
  return { ok: true, client };
}

function isSubsetOf(value: unknown, allowed: ReadonlyArray<string>): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every((item) => allowed.includes(item as string));
}

function metadataError(description: string): RegistrationParse {
  return { ok: false, error: "invalid_client_metadata", description };
}

/**
 * Whether a redirect URI an authorize request names is one the client
 * registered. Exact, except that a loopback http address matches on any port
 * (RFC 8252, section 7.3): native clients listen on whatever port is free.
 */
export function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  if (!registered.startsWith("http:") || !requested.startsWith("http:")) return false;
  let left: URL;
  let right: URL;
  try {
    left = new URL(registered);
    right = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopbackHost(left.hostname) || left.hostname !== right.hostname) return false;
  if (checkRedirectUri(requested, true) === null) return false;
  left.port = "";
  right.port = "";
  return left.href === right.href;
}
