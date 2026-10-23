import { RELAY_HOOK_MAX_BODY_BYTES } from "@threadlines/contracts/relay";
import { isNeverKeptHeader } from "@threadlines/shared/webhookTasks";

import { createJsonResponse } from "../protocol.ts";
import { isRelayV2Enabled, type RelayV2Env } from "./env.ts";
import { type HookDeliveryOutcome, parseHookPath, readCappedBody, verifyHookMac } from "./hooks.ts";

const HOOK_METHODS = new Set(["POST", "PUT", "PATCH"]);
/** A sender gets this long to send its body (GitHub's own limit is 10 s for the whole call). */
const HOOK_BODY_DEADLINE_MS = 10_000;

/** The answer for a made-up, mangled, retired or unknown address: the same as any unknown path. */
export function hookNotFound(): Response {
  return createJsonResponse({ error: "Not found." }, { status: 404 });
}

/**
 * `POST|PUT|PATCH /v2/hooks/{hostId}/{hookId}/{mac}`: the only relay route
 * anyone on the internet can reach without a secret. Checks run cheapest
 * first and nothing here touches a Durable Object until the request passed
 * all of them: the per-IP limit, the mac, the per-hook limit, a
 * Content-Length within the cap, and the body itself, read here within a
 * deadline and the same cap. A slow sender therefore holds only this
 * request, never the host's object, which then checks the hook is still
 * active and seals and stores the delivery.
 */
export async function routeHook(request: Request, env: RelayV2Env): Promise<Response> {
  if (!HOOK_METHODS.has(request.method)) {
    return createJsonResponse(
      { error: "Send events with POST." },
      { status: 405, headers: { Allow: "POST, PUT, PATCH" } },
    );
  }
  if (!isRelayV2Enabled(env)) {
    return createJsonResponse({ error: "This relay is turned off." }, { status: 503 });
  }

  const ip = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
  if (!(await allow(env.HOOK_IP_RATE_LIMITER, `ip:${ip}`))) return tooMany(60);

  const url = new URL(request.url);
  const path = parseHookPath(url.pathname);
  const key = env.HOOK_PATH_KEY?.trim();
  if (!path || !key || !(await verifyHookMac(key, path))) return hookNotFound();

  if (!(await allow(env.HOOK_RATE_LIMITER, `${path.hostId}|${path.hookId}`))) return tooMany(60);

  const length = request.headers.get("Content-Length")?.trim() ?? "";
  if (!/^\d{1,10}$/u.test(length)) {
    return createJsonResponse({ error: "Send a Content-Length header." }, { status: 411 });
  }
  if (Number(length) > RELAY_HOOK_MAX_BODY_BYTES) return tooLarge();
  const read = await readCappedBody(request.body, {
    maxBytes: RELAY_HOOK_MAX_BODY_BYTES,
    deadlineMs: HOOK_BODY_DEADLINE_MS,
  });
  if (!read.ok) {
    if (read.status === 413) return tooLarge();
    return createJsonResponse(
      {
        error: read.status === 408 ? "The event took too long to send." : "The event was cut off.",
      },
      { status: read.status },
    );
  }

  const outcome = await env.RELAY_HOST.getByName(path.hostId).deliverHook({
    hostId: path.hostId,
    hookId: path.hookId,
    method: request.method,
    query: url.search.startsWith("?") ? url.search.slice(1) : url.search,
    headers: [...request.headers].filter(([name]) => !isNeverKeptHeader(name)),
    body: read.body,
  });
  return hookDeliveryResponse(outcome);
}

function hookDeliveryResponse(outcome: HookDeliveryOutcome): Response {
  switch (outcome.status) {
    case 202:
      return createJsonResponse({ accepted: true }, { status: 202 });
    case 404:
      return hookNotFound();
    case 429:
      return tooMany(
        outcome.retryAfterSeconds,
        outcome.reason === "daily-limit"
          ? "This computer took as many events as it can today."
          : "Too many events are waiting for this computer.",
      );
  }
}

/** A limiter that fails lets the request through: its outage shouldn't drop events. */
async function allow(limiter: RateLimit, key: string): Promise<boolean> {
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}

function tooMany(retryAfterSeconds: number, error = "Too many events. Try again in a minute.") {
  return createJsonResponse(
    { error },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

function tooLarge(): Response {
  return createJsonResponse({ error: "Events can be at most 1 MiB." }, { status: 413 });
}
