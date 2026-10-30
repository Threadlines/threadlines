// @effect-diagnostics globalDate:off
import { ASSISTANT_MCP_PATH, type AssistantScope } from "@threadlines/contracts/relayAssistants";
import {
  type AssistantCredential,
  parseAssistantCredential,
  verifyAssistantRouteTag,
} from "@threadlines/shared/assistantCredentials";
import { fromUtf8 } from "@threadlines/shared/relaySecure";

import { createJsonResponse, parseBearerToken } from "../../protocol.ts";
import type { RelayV2Env } from "../env.ts";
import { readCappedBody } from "../hooks.ts";
import {
  type AssistantAnswer,
  answerResponse,
  doorOff,
  forwardedMcpHeaders,
  invalidGrant,
  jsonAnswer,
  limited,
  mcpUnauthorized,
  tokenError,
  tokenUnavailable,
} from "./answers.ts";
import {
  clientIdentity,
  parseRegistration,
  resolveClient,
  signRegisteredClientId,
} from "./clients.ts";
import { type AssistantsConfig, assistantsConfig, assistantsOrigin } from "./config.ts";
import {
  ASSISTANT_SCOPES,
  authorizationServerMetadata,
  protectedResourceMetadata,
} from "./discovery.ts";
import { errorPageResponse, signInPageResponse } from "./page.ts";
import {
  hashPageSecret,
  isPageSecret,
  isSignInId,
  newPageSecret,
  newSignInId,
  signInNetwork,
  signInShardName,
} from "./signIns.ts";

/**
 * The assistants door's public routes (docs/design/assistants.md, "The public
 * address"), answered only on `ASSISTANTS_ORIGIN`:
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728, static
 *   GET  /.well-known/oauth-authorization-server       RFC 8414, static
 *   POST /register                                     stateless DCR
 *   GET  /authorize                                    the sign-in page
 *   POST /authorize/code                               the page sends the app's code
 *   GET  /authorize/status                             the page waits for the decision
 *   POST /token                                        to the computer
 *   POST /mcp                                          to the computer
 *
 * Cheapest checks first, and nothing wakes a Durable Object before they all
 * pass: the method, a limiter that fails closed, the body read within a cap
 * and a deadline, the credential's format, and its route tag. No CORS: these
 * are server-to-server calls and top-level navigations.
 */

const DISCOVERY_RESOURCE = "/.well-known/oauth-protected-resource";
const DISCOVERY_RESOURCE_MCP = `${DISCOVERY_RESOURCE}${ASSISTANT_MCP_PATH}`;
const DISCOVERY_SERVER = "/.well-known/oauth-authorization-server";

const ASSISTANT_PATHS = new Set([
  DISCOVERY_RESOURCE,
  DISCOVERY_RESOURCE_MCP,
  DISCOVERY_SERVER,
  "/register",
  "/authorize",
  "/authorize/code",
  "/authorize/status",
  "/token",
  ASSISTANT_MCP_PATH,
]);

const MCP_BODY_MAX_BYTES = 256 * 1024;
const TOKEN_BODY_MAX_BYTES = 16 * 1024;
const REGISTER_BODY_MAX_BYTES = 16 * 1024;
const CODE_BODY_MAX_BYTES = 2 * 1024;
const BODY_DEADLINE_MS = 10_000;
const STATE_MAX_LENGTH = 1024;
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;
const AUTHORIZE_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
  "scope",
] as const;

export interface AssistantRouteOptions {
  /** CIMD fetches go through this (tests stub it). */
  readonly fetch?: typeof fetch;
}

/**
 * Answers a request on the assistants origin, or null for anything else
 * (another origin, or a path that isn't the door's), which v1 and v2
 * routing then take.
 */
export async function routeAssistants(
  request: Request,
  env: RelayV2Env,
  options: AssistantRouteOptions = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!ASSISTANT_PATHS.has(url.pathname)) return null;
  const origin = assistantsOrigin(env.ASSISTANTS_ORIGIN);
  if (!origin || url.origin !== origin.origin) return null;
  const config = await assistantsConfig(env);
  if (!config.enabled) return answerResponse(doorOff());

  switch (url.pathname) {
    case DISCOVERY_RESOURCE:
    case DISCOVERY_RESOURCE_MCP:
      return discovery(request, protectedResourceMetadata(config.origin));
    case DISCOVERY_SERVER:
      return discovery(request, authorizationServerMetadata(config.origin));
    case "/register":
      return register(request, env, config);
    case "/authorize":
      return authorize(request, url, env, config, options);
    case "/authorize/code":
      return typeCode(request, env, config);
    case "/authorize/status":
      return signInStatus(request, url, env);
    case "/token":
      return answerResponse(await token(request, env, config));
    default:
      return answerResponse(await mcp(request, env, config));
  }
}

function discovery(request: Request, document: unknown): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET");
  return createJsonResponse(document, { headers: { "cache-control": "public, max-age=3600" } });
}

// ----- clients -----------------------------------------------------------------

async function register(
  request: Request,
  env: RelayV2Env,
  config: Extract<AssistantsConfig, { enabled: true }>,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const byIp = await limit(env.ASSISTANT_SIGN_IN_RATE_LIMITER, `register:${clientIp(request)}`);
  if (byIp !== "allowed") return answerResponse(limited("page", byIp));
  const read = await readBody(request, REGISTER_BODY_MAX_BYTES);
  if (!read.ok) return answerResponse(read.answer);
  const parsed = parseRegistration(parseJsonObject(read.text), config.loopback);
  if (!parsed.ok) {
    return answerResponse(
      jsonAnswer(400, { error: parsed.error, error_description: parsed.description }),
    );
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const clientId = await signRegisteredClientId(config.clientKey, parsed.registration, issuedAt);
  if (!clientId) {
    return answerResponse(
      jsonAnswer(400, {
        error: "invalid_client_metadata",
        error_description: "This registration is too large.",
      }),
    );
  }
  const { registration } = parsed;
  return answerResponse(
    jsonAnswer(201, {
      client_id: clientId,
      client_id_issued_at: issuedAt,
      client_name: registration.name,
      redirect_uris: registration.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(registration.softwareId ? { software_id: registration.softwareId } : {}),
    }),
  );
}

// ----- the sign-in page --------------------------------------------------------

async function authorize(
  request: Request,
  url: URL,
  env: RelayV2Env,
  config: Extract<AssistantsConfig, { enabled: true }>,
  options: AssistantRouteOptions,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const ip = clientIp(request);
  const byIp = await limit(env.ASSISTANT_SIGN_IN_RATE_LIMITER, `authorize:${ip}`);
  if (byIp === "failed")
    return errorPageResponse(503, "Threadlines can't take sign-ins right now.");
  if (byIp === "refused") {
    return errorPageResponse(429, "Too many sign-ins from your network. Wait a minute.");
  }

  const params = url.searchParams;
  if (AUTHORIZE_PARAMS.some((name) => params.getAll(name).length > 1)) {
    return errorPageResponse(400, "This sign-in link repeats a setting it may only have once.");
  }
  const clientId = params.get("client_id") ?? "";
  if (!clientId)
    return errorPageResponse(400, "This sign-in link doesn't say which assistant it's for.");
  const resolved = await resolveClient(clientId, {
    clientKey: config.clientKey,
    allowLoopbackHttp: config.loopback,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  if (!resolved.ok) return errorPageResponse(400, resolved.reason);
  const { client } = resolved;
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!client.redirectUris.includes(redirectUri)) {
    return errorPageResponse(
      400,
      "This sign-in link returns somewhere the assistant didn't register.",
    );
  }

  // The client and its return address check out, but nothing here redirects
  // on its own: a registered return address can still be anyone's, and an
  // error redirect would make this page a way to send people there.
  if (params.get("response_type") !== "code") {
    return errorPageResponse(
      400,
      "This assistant asked for a kind of sign-in Threadlines doesn't support.",
    );
  }
  const state = params.get("state") ?? "";
  if (!state || state.length > STATE_MAX_LENGTH) {
    return errorPageResponse(400, "This sign-in link is missing its state, or it's too long.");
  }
  const challenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !CODE_CHALLENGE.test(challenge)) {
    return errorPageResponse(
      400,
      "This assistant didn't send the sign-in check Threadlines needs (PKCE with S256).",
    );
  }
  const resource = params.get("resource");
  if (resource !== null && resource !== config.resource) {
    return errorPageResponse(400, "This sign-in link is for a different server.");
  }
  const scopes = requestedScopes(params.get("scope"));
  if (!scopes) {
    return errorPageResponse(400, "This assistant asked for access Threadlines doesn't offer.");
  }

  const network = await signInNetwork(ip);
  const signInId = newSignInId(network.shard);
  const pageSecret = newPageSecret();
  const identity = clientIdentity(client, redirectUri);
  let created: { readonly ok: boolean };
  try {
    created = await env.RELAY_ASSISTANT_SIGN_IN.getByName(signInShardName(signInId)).create({
      signInId,
      ipHash: network.ipHash,
      pageSecretHash: await hashPageSecret(pageSecret),
      clientId,
      clientName: client.name,
      identity,
      redirectUri,
      oauthState: state,
      codeChallenge: challenge,
      scopes,
      resource: config.resource,
      issuer: config.origin,
      place: requestPlace(request),
    });
  } catch {
    return errorPageResponse(
      503,
      "Threadlines can't take sign-ins right now. Try again in a minute.",
    );
  }
  if (!created.ok) {
    return errorPageResponse(
      429,
      "Too many sign-ins are waiting from your network. Finish one, or wait 10 minutes.",
    );
  }
  return signInPageResponse({ clientName: client.name, identity, signInId, pageSecret });
}

/** The scopes asked for, in a fixed order; none asked means both. Null for anything else. */
export function requestedScopes(scope: string | null): AssistantScope[] | null {
  const asked = (scope ?? "").split(" ").filter(Boolean);
  if (asked.length === 0) return [...ASSISTANT_SCOPES];
  if (!asked.every((item) => (ASSISTANT_SCOPES as ReadonlyArray<string>).includes(item))) {
    return null;
  }
  return ASSISTANT_SCOPES.filter((item) => asked.includes(item));
}

/** Roughly where the page was opened, from Cloudflare's request data. Information only. */
function requestPlace(request: Request): { city?: string; country?: string } | null {
  const cf = (request as Request & { readonly cf?: { city?: unknown; country?: unknown } }).cf;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : undefined;
  const city = text(cf?.city);
  const country = text(cf?.country);
  if (!city && !country) return null;
  return { ...(city ? { city } : {}), ...(country ? { country } : {}) };
}

async function typeCode(
  request: Request,
  env: RelayV2Env,
  config: Extract<AssistantsConfig, { enabled: true }>,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== config.origin) {
    return answerResponse(jsonAnswer(403, { error: "Origin is not allowed." }));
  }
  const byIp = await limit(env.ASSISTANT_SIGN_IN_RATE_LIMITER, `code:${clientIp(request)}`);
  if (byIp !== "allowed") return answerResponse(limited("page", byIp));
  const read = await readBody(request, CODE_BODY_MAX_BYTES);
  if (!read.ok) return answerResponse(read.answer);
  const body = parseJsonObject(read.text);
  const { signInId, pageSecret, code } = body ?? {};
  if (
    !isSignInId(signInId) ||
    !isPageSecret(pageSecret) ||
    typeof code !== "string" ||
    code.length > 32
  ) {
    return answerResponse(jsonAnswer(400, { error: "Missing or invalid sign-in fields." }));
  }
  try {
    const outcome = await env.RELAY_ASSISTANT_SIGN_IN.getByName(signInShardName(signInId)).typeCode(
      { signInId, pageSecretHash: await hashPageSecret(pageSecret), code },
    );
    return answerResponse(jsonAnswer(200, outcome));
  } catch {
    return answerResponse(jsonAnswer(503, { error: "Threadlines can't check codes right now." }));
  }
}

async function signInStatus(request: Request, url: URL, env: RelayV2Env): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const byIp = await limit(env.ASSISTANT_STATUS_RATE_LIMITER, `status:${clientIp(request)}`);
  if (byIp !== "allowed") return answerResponse(limited("page", byIp));
  const signInId = url.searchParams.get("signInId");
  const pageSecret = url.searchParams.get("pageSecret");
  if (!isSignInId(signInId) || !isPageSecret(pageSecret)) {
    return answerResponse(jsonAnswer(400, { error: "Missing or invalid sign-in fields." }));
  }
  try {
    const status = await env.RELAY_ASSISTANT_SIGN_IN.getByName(signInShardName(signInId)).status({
      signInId,
      pageSecretHash: await hashPageSecret(pageSecret),
    });
    return answerResponse(jsonAnswer(200, { status }));
  } catch {
    return answerResponse(
      jsonAnswer(503, { error: "Threadlines can't check this sign-in right now." }),
    );
  }
}

// ----- to the computer ---------------------------------------------------------

/** `POST /token`: the code or refresh token routes the form to its computer, which answers it. */
async function token(
  request: Request,
  env: RelayV2Env,
  config: Extract<AssistantsConfig, { enabled: true }>,
): Promise<AssistantAnswer> {
  if (request.method !== "POST") return withAllow(tokenError(405, "invalid_request"), "POST");
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return tokenError(400, "invalid_request");
  }
  const read = await readBody(request, TOKEN_BODY_MAX_BYTES);
  if (!read.ok) return tokenError(read.answer.status === 408 ? 408 : 400, "invalid_request");
  const form = new URLSearchParams(read.text);
  const grantType = form.get("grant_type");
  const expected =
    grantType === "authorization_code" ? "code" : grantType === "refresh_token" ? "refresh" : null;
  if (expected === null) return tokenError(400, "unsupported_grant_type");
  const raw = form.get(expected === "code" ? "code" : "refresh_token");
  if (!raw) return tokenError(400, "invalid_request");
  const credential = await routableCredential(raw, [expected], config);
  if (!credential) return invalidGrant();

  const { hostId, connectionId } = credential.route;
  const byConnection = await limit(
    env.ASSISTANT_CONNECTION_RATE_LIMITER,
    `token:${hostId}|${connectionId}`,
  );
  if (byConnection !== "allowed") return limited("token", byConnection);
  try {
    return await env.RELAY_HOST.getByName(hostId).assistantRequest({
      route: "token",
      hostId,
      connectionId,
      credential: raw,
      headers: { "content-type": contentType },
      body: read.text,
    });
  } catch {
    return tokenUnavailable();
  }
}

/** `POST /mcp`: an access token or key routes the JSON-RPC message to its computer. */
async function mcp(
  request: Request,
  env: RelayV2Env,
  config: Extract<AssistantsConfig, { enabled: true }>,
): Promise<AssistantAnswer> {
  if (request.method !== "POST") {
    return withAllow(jsonAnswer(405, { error: "Send MCP requests with POST." }), "POST");
  }
  const authorization = request.headers.get("Authorization");
  if (authorization === null) return mcpUnauthorized(config.origin, false);
  const raw = parseBearerToken(authorization);
  const credential = raw ? await routableCredential(raw, ["access", "key"], config) : null;
  if (!raw || !credential) return mcpUnauthorized(config.origin, true);

  const { hostId, connectionId } = credential.route;
  const byConnection = await limit(
    env.ASSISTANT_CONNECTION_RATE_LIMITER,
    `mcp:${hostId}|${connectionId}`,
  );
  if (byConnection !== "allowed") return limited("mcp", byConnection);
  const read = await readBody(request, MCP_BODY_MAX_BYTES);
  if (!read.ok) return read.answer;
  try {
    return await env.RELAY_HOST.getByName(hostId).assistantRequest({
      route: "mcp",
      hostId,
      connectionId,
      credential: raw,
      headers: forwardedMcpHeaders(request.headers),
      body: read.text,
    });
  } catch {
    return jsonAnswer(
      503,
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message: "The Threadlines relay can't take this request right now.",
        },
      },
      { "retry-after": "60" },
    );
  }
}

/**
 * A credential of one of `kinds` whose route tag this relay minted, or null.
 * Shape and tag only: the computer checks the rest. Junk never gets further.
 */
async function routableCredential(
  raw: string,
  kinds: ReadonlyArray<AssistantCredential["kind"]>,
  config: Extract<AssistantsConfig, { enabled: true }>,
): Promise<AssistantCredential | null> {
  const credential = parseAssistantCredential(raw);
  if (!credential || !kinds.includes(credential.kind)) return null;
  return (await verifyAssistantRouteTag(config.routeKey, credential.route)) ? credential : null;
}

// ----- helpers -----------------------------------------------------------------

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
}

/** "allowed", or why not. A limiter that can't answer refuses: this door fails closed. */
async function limit(limiter: RateLimit, key: string): Promise<"allowed" | "refused" | "failed"> {
  try {
    return (await limiter.limit({ key })).success ? "allowed" : "refused";
  } catch {
    return "failed";
  }
}

type BodyText =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly answer: AssistantAnswer };

/** The body as text, within a cap (its Content-Length checked first) and a deadline. */
async function readBody(request: Request, maxBytes: number): Promise<BodyText> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^\d{1,10}$/u.test(declared.trim()) || Number(declared) > maxBytes)) {
    return { ok: false, answer: jsonAnswer(413, { error: "This request is too large." }) };
  }
  const read = await readCappedBody(request.body, { maxBytes, deadlineMs: BODY_DEADLINE_MS });
  if (read.ok) return { ok: true, text: fromUtf8(read.body) };
  const error =
    read.status === 413
      ? "This request is too large."
      : read.status === 408
        ? "This request took too long to send."
        : "This request was cut off.";
  return { ok: false, answer: jsonAnswer(read.status, { error }) };
}

function methodNotAllowed(allow: string): Response {
  return answerResponse(withAllow(jsonAnswer(405, { error: `Use ${allow}.` }), allow));
}

function withAllow(answer: AssistantAnswer, allow: string): AssistantAnswer {
  return { ...answer, headers: { ...answer.headers, allow } };
}
