/**
 * Where the agent's browser tools arrive.
 *
 * One HTTP endpoint rather than a delivery path per provider: Claude takes an
 * MCP server of `type: "http"` with headers, and Codex takes a URL and a bearer
 * through its thread config, so the same door serves both and there is only one
 * place for the auth to be wrong.
 *
 * Every request carries a credential that says which thread it belongs to, and
 * that is the only thing that decides which browser it can drive -- see
 * McpSessionRegistry for why the model is not asked.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Types from "effect/Types";
import { McpServer } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { BrowserToolkit } from "./browserTools.ts";
import { BrowserToolkitHandlersLive } from "./browserToolHandlers.ts";
import { McpInvocationContext } from "./McpInvocationContext.ts";
import { mcpSessionRegistry } from "./McpSessionRegistry.ts";

/** Where the endpoint lives, shared with whoever has to tell a provider about it. */
/** How the tools are namespaced to a provider, so `browser_click` arrives as
 *  something the user can recognise in the transcript. */
export const BROWSER_MCP_SERVER_NAME = "threadlines_browser";
export const MCP_ROUTE_PATH = "/mcp";

/**
 * What a provider needs to be told to reach the browser tools.
 *
 * Loopback regardless of what the server is bound to: this address is handed to
 * a process on this machine, and pointing it at a public interface would put
 * the tools somewhere they have no reason to be.
 */
export function mcpEndpointUrl(port: number): string {
  return `http://127.0.0.1:${port}${MCP_ROUTE_PATH}`;
}

/**
 * The same endpoint, in the shape Codex takes it.
 *
 * Codex configures MCP servers through a flat config overlay on thread/start
 * rather than a structured field, so this is the one place that knows the key
 * names. Claude gets the same URL and the same credential a different way; that
 * they agree is the point of there being one endpoint.
 */
export function codexBrowserThreadConfig(input: {
  readonly port: number;
  readonly credential: string;
}): Record<string, string> {
  const prefix = `mcp_servers.${BROWSER_MCP_SERVER_NAME}`;
  return {
    [`${prefix}.url`]: mcpEndpointUrl(input.port),
    [`${prefix}.bearer_token`]: input.credential,
  };
}

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_credential",
    message: "A thread-scoped bearer credential is required.",
  },
  {
    status: 401,
    headers: { "cache-control": "no-store", "www-authenticate": "Bearer" },
  },
);

const authenticate = Effect.succeed(
  Effect.fn("McpHttpServer.authenticate")(function* (
    handler: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      Types.unhandled,
      McpInvocationContext
    >,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const scope = yield* mcpSessionRegistry.resolve(token);
    if (scope === null) {
      return unauthorized;
    }
    return yield* handler.pipe(
      Effect.provideService(McpInvocationContext, { threadId: scope.threadId }),
    );
  }),
);

const AuthenticationLive = HttpRouter.middleware<{
  provides: McpInvocationContext;
}>()(authenticate).layer;

/**
 * The stream this server does not offer, said properly.
 *
 * Streamable HTTP lets a client open a GET stream for server-initiated
 * messages, and a server that has none must answer 405. Ours had no GET route
 * at all, so the request fell through to the web app's catch-all and came back
 * a 302 to an HTML page -- which a client reads as neither "here is the stream"
 * nor "there is no stream", and sits in connecting on.
 */
const noServerStreamRoute = HttpRouter.add(
  "GET",
  MCP_ROUTE_PATH,
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      {
        jsonrpc: "2.0",
        error: { code: -32000, message: "This server does not offer an event stream." },
      },
      { status: 405, headers: { allow: "POST" } },
    ),
  ),
);

export const layer = McpServer.toolkit(BrowserToolkit).pipe(
  Layer.provide(BrowserToolkitHandlersLive),
  Layer.provideMerge(
    McpServer.layerHttp({
      name: "threadlines-browser",
      version: "1",
      path: MCP_ROUTE_PATH,
    }).pipe(Layer.provide(AuthenticationLive)),
  ),
  Layer.provideMerge(noServerStreamRoute),
);
