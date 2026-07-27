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
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import type * as Types from "effect/Types";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  BrowserScreenshotTool,
  BrowserScreenshotToolkit,
  BrowserStandardToolkit,
} from "./browserTools.ts";
import {
  BrowserScreenshotHandlersLive,
  BrowserToolkitHandlersLive,
} from "./browserToolHandlers.ts";
import { McpInvocationContext } from "./McpInvocationContext.ts";
import { mcpSessionRegistry } from "./McpSessionRegistry.ts";
import { PreviewAutomationBroker } from "../preview/PreviewAutomationBroker.ts";

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
 * names -- and which of them its transports accept. Claude gets the same URL and the same credential a different way; that
 * they agree is the point of there being one endpoint.
 */
export function codexBrowserThreadConfig(input: {
  readonly port: number;
  readonly credential: string;
}): Record<string, Schema.Json> {
  const prefix = `mcp_servers.${BROWSER_MCP_SERVER_NAME}`;
  return {
    [`${prefix}.url`]: mcpEndpointUrl(input.port),
    // Headers rather than `bearer_token`: Codex accepts that key only for its
    // other transport and refuses to start a thread at all when it appears on
    // a streamable HTTP server -- not a browser without tools, a session that
    // will not begin.
    [`${prefix}.http_headers`]: { Authorization: `Bearer ${input.credential}` },
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

/**
 * The screenshot tool, registered by hand so it can answer with a picture.
 *
 * A toolkit puts whatever a tool returns into `structuredContent`, which for a
 * screenshot means a base64 string in a JSON field -- thousands of tokens the
 * model cannot see. It was, in our own agent's words, strictly worse than the
 * tool not existing.
 *
 * MCP has an image content type for exactly this. Getting at it means doing
 * what the toolkit does internally -- run the handler, take its one result --
 * and then splitting the image out of the payload into a content block, with
 * the dimensions left behind as text so the model can reason about size
 * without being handed the bytes twice.
 */
const registerScreenshot = Effect.fn("McpHttpServer.registerScreenshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker;
  const built = yield* BrowserScreenshotToolkit;
  const tool = BrowserScreenshotTool;

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      // The thread comes off the request's own fiber. A hand-registered
      // handler does not run under the router middleware that provides it, so
      // reading it from the surrounding scope would get whichever request
      // happened to build this layer.
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(fiber.context, McpInvocationContext);
        return built.handle("browser_screenshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker, broker),
          Effect.provideService(McpInvocationContext, invocation),
          Effect.matchCauseEffect({
            onFailure: screenshotFailure,
            onSuccess: ({ encodedResult }) => {
              const shot = encodedResult as {
                readonly data: string;
                readonly width: number;
                readonly height: number;
              };
              return Effect.succeed(
                new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: { width: shot.width, height: shot.height },
                  content: [
                    {
                      type: "text",
                      text: `Screenshot of the page, ${shot.width}x${shot.height} CSS pixels.`,
                    },
                    {
                      type: "image",
                      data: new Uint8Array(Buffer.from(shot.data, "base64")),
                      mimeType: "image/png",
                    },
                  ],
                }),
              );
            },
          }),
        );
      }),
  });
});

/** A hand-registered tool has to build its own failure result; nothing above it
 *  will turn a cause into something the model can read. */
const screenshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failure = cause.reasons.find(Cause.isFailReason)?.error;
  const message =
    typeof failure === "object" && failure !== null && "message" in failure
      ? String(failure.message)
      : "The screenshot could not be taken.";
  return Effect.succeed(
    new McpSchema.CallToolResult({
      isError: true,
      content: [{ type: "text", text: message }],
    }),
  );
};

export const layer = McpServer.toolkit(BrowserStandardToolkit).pipe(
  Layer.provide(BrowserToolkitHandlersLive),
  Layer.provideMerge(
    Layer.effectDiscard(registerScreenshot()).pipe(Layer.provide(BrowserScreenshotHandlersLive)),
  ),
  Layer.provideMerge(
    McpServer.layerHttp({
      name: "threadlines-browser",
      version: "1",
      path: MCP_ROUTE_PATH,
    }).pipe(Layer.provide(AuthenticationLive)),
  ),
  Layer.provideMerge(noServerStreamRoute),
);
