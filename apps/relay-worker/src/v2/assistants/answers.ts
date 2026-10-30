/**
 * HTTP answers on the assistants door, built where the decision is made (the
 * edge or the host's object) and turned into a Response at the edge. An
 * answer is plain data so it crosses the Durable Object RPC boundary as is.
 *
 * Offline answers say nothing a stranger holding an old credential shouldn't
 * learn: no computer name, no last seen (docs/design/assistants.md, "Offline
 * and sleep").
 */
export interface AssistantAnswer {
  readonly status: number;
  /** Lowercase names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export const OFFLINE_TEXT =
  "Your Threadlines computer is offline (asleep, or Threadlines is closed). Try again later.";
const TIMEOUT_TEXT = "Your Threadlines computer didn't answer in time. Try again.";
const DROPPED_TEXT = "The connection to your Threadlines computer dropped. Try again.";
const BUSY_TEXT = "Your Threadlines computer is busy with other requests. Try again in a moment.";
const DAILY_LIMIT_TEXT = "Your Threadlines computer took as many requests as it can today.";
const RELAY_BUSY_TEXT = "The Threadlines relay is busy. Try again later.";
const TOO_MANY_TEXT = "Too many requests. Try again in a minute.";

/** Request headers that go to the computer with an MCP request, lowercased. */
export const MCP_REQUEST_HEADERS = [
  "content-type",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
  "mcp-session-id",
] as const;
const MCP_RESPONSE_HEADERS = new Set([
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "www-authenticate",
]);
const TOKEN_RESPONSE_HEADERS = new Set(["content-type", "cache-control", "pragma"]);
/** A request header value longer than this is cut from what the computer sees. */
const MAX_HEADER_VALUE_LENGTH = 1024;

/** The allowed request headers of an MCP request, lowercased and bounded. */
export function forwardedMcpHeaders(headers: Headers): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of MCP_REQUEST_HEADERS) {
    const value = headers.get(name);
    if (value !== null && value.length <= MAX_HEADER_VALUE_LENGTH) kept[name] = value;
  }
  return kept;
}

/** The computer's response headers the assistant may see, for one route. */
export function passedResponseHeaders(
  route: "mcp" | "token",
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const allowed = route === "mcp" ? MCP_RESPONSE_HEADERS : TOKEN_RESPONSE_HEADERS;
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (allowed.has(lower) && !/[\r\n]/u.test(value)) kept[lower] = value;
  }
  return kept;
}

export function answerResponse(answer: AssistantAnswer): Response {
  return new Response(answer.status === 204 || answer.status === 304 ? null : answer.body, {
    status: answer.status,
    headers: answer.headers,
  });
}

export function jsonAnswer(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): AssistantAnswer {
  return {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
    body: JSON.stringify(body),
  };
}

// ----- /mcp ------------------------------------------------------------------

/** `WWW-Authenticate` for the MCP resource: where to find how to sign in. */
export function mcpChallenge(origin: string, invalidToken: boolean): string {
  const metadata = `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`;
  return invalidToken ? `Bearer error="invalid_token", ${metadata}` : `Bearer ${metadata}`;
}

/** 401 for a missing, malformed, made-up or removed credential. */
export function mcpUnauthorized(origin: string, invalidToken: boolean): AssistantAnswer {
  return jsonAnswer(
    401,
    invalidToken
      ? { error: "invalid_token", error_description: "Sign in to Threadlines again." }
      : { error: "unauthorized", error_description: "Sign in to Threadlines first." },
    { "www-authenticate": mcpChallenge(origin, invalidToken) },
  );
}

type JsonRpcId = string | number | null;

/** The request's JSON-RPC id and method, when the body is one JSON-RPC message (never a batch). */
export function jsonRpcRequest(body: string): {
  readonly id: JsonRpcId;
  readonly method: string | null;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const message = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown };
  if (message.jsonrpc !== "2.0") return null;
  const id =
    typeof message.id === "string" ||
    (typeof message.id === "number" && Number.isFinite(message.id))
      ? message.id
      : null;
  return { id, method: typeof message.method === "string" ? message.method : null };
}

function jsonRpcError(
  status: number,
  id: JsonRpcId,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): AssistantAnswer {
  return jsonAnswer(status, { jsonrpc: "2.0", id, error: { code: -32000, message } }, headers);
}

/**
 * The computer has no live assistant socket. A tool call gets a tool error
 * the model reads; anything else a 503 with the same words.
 */
export function mcpOffline(body: string): AssistantAnswer {
  const request = jsonRpcRequest(body);
  if (request?.method === "tools/call" && request.id !== null) {
    return jsonAnswer(200, {
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [{ type: "text", text: OFFLINE_TEXT }], isError: true },
    });
  }
  return jsonRpcError(503, request?.id ?? null, OFFLINE_TEXT, { "retry-after": "60" });
}

export function mcpTimedOut(body: string): AssistantAnswer {
  return jsonRpcError(504, jsonRpcRequest(body)?.id ?? null, TIMEOUT_TEXT);
}

export function mcpDropped(body: string): AssistantAnswer {
  return jsonRpcError(502, jsonRpcRequest(body)?.id ?? null, DROPPED_TEXT);
}

export function mcpBusy(body: string): AssistantAnswer {
  return jsonRpcError(503, jsonRpcRequest(body)?.id ?? null, BUSY_TEXT, { "retry-after": "5" });
}

export function mcpRelayBusy(body: string): AssistantAnswer {
  return jsonRpcError(503, jsonRpcRequest(body)?.id ?? null, RELAY_BUSY_TEXT, {
    "retry-after": "900",
  });
}

export function mcpDailyLimit(body: string, retryAfterSeconds: number): AssistantAnswer {
  return jsonRpcError(429, jsonRpcRequest(body)?.id ?? null, DAILY_LIMIT_TEXT, {
    "retry-after": String(retryAfterSeconds),
  });
}

/** The computer answered with something that isn't an HTTP answer. */
export function badGateway(): AssistantAnswer {
  return jsonAnswer(502, {
    error: "Your Threadlines computer sent an answer the relay can't use.",
  });
}

// ----- /token ----------------------------------------------------------------

/** RFC 6749 error answers. Offline is never `invalid_grant`: clients drop the connection on that. */
export function tokenError(
  status: number,
  error: string,
  headers: Readonly<Record<string, string>> = {},
): AssistantAnswer {
  return jsonAnswer(status, { error }, { pragma: "no-cache", ...headers });
}

export function tokenUnavailable(retryAfterSeconds = 60): AssistantAnswer {
  return tokenError(503, "temporarily_unavailable", { "retry-after": String(retryAfterSeconds) });
}

export function invalidGrant(): AssistantAnswer {
  return tokenError(400, "invalid_grant");
}

// ----- shared ----------------------------------------------------------------

/** A limiter said no (429), or couldn't answer (503): this door fails closed. */
export function limited(
  route: "mcp" | "token" | "page",
  outcome: "refused" | "failed",
): AssistantAnswer {
  const status = outcome === "refused" ? 429 : 503;
  const retry = { "retry-after": "60" };
  if (route === "token") {
    return outcome === "refused"
      ? tokenError(429, "temporarily_unavailable", retry)
      : tokenUnavailable();
  }
  if (route === "mcp") return jsonRpcError(status, null, TOO_MANY_TEXT, retry);
  return jsonAnswer(status, { error: TOO_MANY_TEXT }, retry);
}

/** The door is turned off on this relay. */
export function doorOff(): AssistantAnswer {
  return jsonAnswer(
    503,
    { error: "Assistants are turned off on this relay." },
    {
      "retry-after": "3600",
    },
  );
}
