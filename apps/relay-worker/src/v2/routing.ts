// @effect-diagnostics globalDate:off cryptoRandomUUID:off globalConsole:off
import { generateToken, sha256Base64Url } from "../crypto.ts";
import { createJsonResponse } from "../protocol.ts";
import { codeShardName } from "./codeShardCore.ts";
import { isRelayV2Enabled, type RelayV2Env } from "./env.ts";
import { joinErrorStatus, parseJoinBody } from "./http.ts";
import { RELAY_LEDGER_NAME } from "./RelayLedger.ts";

const HOST_ROUTE = /^\/v2\/hosts\/([0-9a-f-]{36})(?:\/|$)/u;
/**
 * Joiner-reachable POSTs that share the per-IP join budget with code joins.
 * Split the way the host object splits paths (empty segments dropped), so a
 * trailing slash can't route around the limit.
 */
function isJoinLimitedPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return (
    segments.length === 6 &&
    segments[0] === "v2" &&
    segments[1] === "hosts" &&
    ((segments[3] === "invites" && segments[5] === "claim") ||
      (segments[3] === "requests" && segments[5] === "reveal"))
  );
}

/**
 * Routes `/v2/*`. Returns null for paths it doesn't own.
 *
 * Origin rules: registration is server-to-server only (no browser Origin);
 * the code-join route, the only one a guess can reach, accepts only the
 * hosted app origins or no Origin; every other route is gated by a secret and
 * accepts any Origin.
 */
export async function routeV2(
  request: Request,
  env: RelayV2Env,
  allowedOrigins: ReadonlySet<string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v2/")) {
    return null;
  }
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (!isRelayV2Enabled(env)) {
    return withCors(origin, json({ error: "Device codes are turned off on this relay." }, 503));
  }

  if (request.method === "POST" && url.pathname === "/v2/hosts") {
    if (origin) {
      return json({ error: "Computers register from the Threadlines server, not a browser." }, 403);
    }
    return registerHost(request, env);
  }

  if (request.method === "POST" && url.pathname === "/v2/join") {
    if (origin && !allowedOrigins.has(origin)) {
      return json({ error: "Origin is not allowed." }, 403);
    }
    return withCors(origin, await joinWithCode(request, env));
  }

  const hostMatch = HOST_ROUTE.exec(url.pathname);
  if (hostMatch) {
    if (request.method === "POST" && isJoinLimitedPath(url.pathname)) {
      const limited = await limitJoins(request, env);
      if (limited) return withCors(origin, limited);
    }
    const response = await env.RELAY_HOST.getByName(hostMatch[1]!).fetch(request);
    return response.status === 101 ? response : withCors(origin, response);
  }

  return withCors(origin, json({ error: "Not found." }, 404));
}

async function registerHost(request: Request, env: RelayV2Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
  const limited = await env.SESSION_CREATE_RATE_LIMITER.limit({ key: `register:${ip}` });
  if (!limited.success) {
    return json({ error: "Too many registrations. Try again in a minute." }, 429);
  }
  const allowed = await env.RELAY_LEDGER.getByName(RELAY_LEDGER_NAME).allowRegistration(
    await sha256Base64Url(ip),
  );
  if (!allowed) {
    return json({ error: "Too many registrations from this network today." }, 429);
  }

  const body = (await readJson(request)) as { label?: unknown; environmentId?: unknown } | null;
  const label = typeof body?.label === "string" ? body.label.trim().slice(0, 120) : "";
  const environmentId =
    typeof body?.environmentId === "string" ? body.environmentId.trim().slice(0, 100) : "";
  if (!label || !environmentId) {
    return json({ error: "A computer name and environment id are required." }, 400);
  }

  const hostId = crypto.randomUUID();
  const hostSecret = generateToken();
  await env.RELAY_HOST.getByName(hostId).initialize({
    hostId,
    secretHash: await sha256Base64Url(hostSecret),
    label,
    environmentId,
  });
  return json({ hostId, hostSecret }, 201);
}

/** Code joins and QR claims share one per-IP budget. Returns the refusal, if any. */
async function limitJoins(request: Request, env: RelayV2Env): Promise<Response | null> {
  const ip = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
  const limited = await env.JOIN_RATE_LIMITER.limit({ key: `join:${ip}` });
  return limited.success
    ? null
    : json({ error: "Too many tries. Wait a minute, then try again.", code: "rate-limited" }, 429);
}

async function joinWithCode(request: Request, env: RelayV2Env): Promise<Response> {
  const limited = await limitJoins(request, env);
  if (limited) return limited;

  const body = (await readJson(request)) as Record<string, unknown> | null;
  const parsed = parseJoinBody(body, "code");
  const code = parsed?.secret.replace(/\s+/gu, "") ?? "";
  if (!parsed || !/^\d{6}$/u.test(code)) {
    return json({ error: "Codes are 6 digits.", code: "invalid-code" }, 400);
  }

  const owner = await env.RELAY_CODE_SHARD.getByName(codeShardName(code)).lookup(code);
  if (!owner) {
    return json(
      {
        error: "That code didn't work. It may have expired or been used already.",
        code: "invalid-code",
      },
      404,
    );
  }

  const outcome = await env.RELAY_HOST.getByName(owner.hostId).join({
    inviteId: owner.inviteId,
    joinId: parsed.joinId,
    deviceSecretHash: parsed.deviceSecretHash,
    requestSecretHash: parsed.requestSecretHash,
    devicePublicKey: parsed.devicePublicKey,
    ...(parsed.commitment ? { commitment: parsed.commitment } : {}),
    joiner: parsed.joiner,
  });
  if (!outcome.ok) {
    return json({ error: outcome.message, code: outcome.code }, joinErrorStatus(outcome.code));
  }
  return json(outcome.result, 201);
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers();
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization,Content-Type");
  return headers;
}

function withCors(origin: string | null, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of corsHeaders(origin)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(body: unknown, status = 200): Response {
  return createJsonResponse(body, { status });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
