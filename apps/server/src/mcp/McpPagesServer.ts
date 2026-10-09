/**
 * The page tools' endpoint, `threadlines_pages` at `/mcp/pages`
 * (docs/agent-pages.md).
 *
 * Its own MCP server rather than more tools on `/mcp`: Codex approves tool
 * calls per server, and these two may run without asking while the browser
 * tools may not. Built as a fresh, isolated layer for the same reason as
 * McpRoomServer: two `McpServer.layerHttp` layers from one memo map share one
 * registry, and each endpoint would list the other's tools.
 *
 * The same bearer credentials as `/mcp` (McpSessionRegistry); a credential
 * reaches this endpoint only if it carries the `pages` grant. Both tools are
 * registered by hand: `preview_page` answers with an MCP image block, which a
 * toolkit cannot produce, and `show_page` keeps the same shape beside it.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, type HttpServerResponse } from "effect/unstable/http";

import { AgentPages } from "../pages/AgentPages.ts";
import {
  MCP_PAGES_ROUTE_PATH,
  normalizeMcpHttpResponse,
  readBearerToken,
  unauthorizedMcpResponse,
} from "./McpHttpServer.ts";
import { type McpInvocationScope, mcpSessionRegistry } from "./McpSessionRegistry.ts";
import {
  PreviewPageParameters,
  PreviewPageTool,
  ShowPageParameters,
  ShowPageTool,
} from "./pageTools.ts";

/** Which runtime a page tool call came from: the full credential scope. */
export class McpPagesInvocation extends Context.Service<McpPagesInvocation, McpInvocationScope>()(
  "@threadlines/server/mcp/McpPagesInvocation",
) {}

const authenticate = Effect.succeed(
  Effect.fn("McpPagesServer.authenticate")(function* (
    handler: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      Types.unhandled,
      McpPagesInvocation
    >,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const scope = yield* mcpSessionRegistry.resolve(readBearerToken(request));
    if (scope === null || !scope.pages) {
      return unauthorizedMcpResponse;
    }
    return yield* handler.pipe(
      Effect.provideService(McpPagesInvocation, scope),
      Effect.map(normalizeMcpHttpResponse),
    );
  }),
);

const AuthenticationLive = HttpRouter.middleware<{
  provides: McpPagesInvocation;
}>()(authenticate).layer;

const describe = (tool: typeof ShowPageTool | typeof PreviewPageTool) =>
  new McpSchema.Tool({
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
  });

const textResult = (text: string, isError: boolean, structured?: Record<string, unknown>) =>
  new McpSchema.CallToolResult({
    isError,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    content: [{ type: "text", text }],
  });

const invalidInput = (error: unknown) =>
  textResult(
    `The arguments do not fit the tool's schema: ${error instanceof Error ? error.message : String(error)}`,
    true,
  );

const registerPageTools = Effect.fn("McpPagesServer.registerPageTools")(function* () {
  const server = yield* McpServer.McpServer;
  const pages = yield* AgentPages;
  const decodeShow = Schema.decodeUnknownEffect(ShowPageParameters);
  const decodePreview = Schema.decodeUnknownEffect(PreviewPageParameters);

  // The caller comes off the request's own fiber: a hand-registered handler
  // does not run under the router middleware that provides it.
  const callerOf = (fiber: { readonly context: Context.Context<never> }) =>
    Context.getUnsafe(fiber.context as Context.Context<McpPagesInvocation>, McpPagesInvocation);

  yield* server.addTool({
    tool: describe(ShowPageTool),
    annotations: ShowPageTool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) =>
        decodeShow(payload).pipe(
          Effect.flatMap((input) => pages.show(callerOf(fiber), input)),
          Effect.map((outcome) =>
            outcome.outcome === "shown"
              ? textResult(
                  `${outcome.message} pageId: ${outcome.pageId} (version ${outcome.version}); pass it as pageId to update this page.`,
                  false,
                  { ...outcome },
                )
              : textResult(outcome.detail, true, { ...outcome }),
          ),
          Effect.catch((error) => Effect.succeed(invalidInput(error))),
        ),
      ),
  });

  yield* server.addTool({
    tool: describe(PreviewPageTool),
    annotations: PreviewPageTool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) =>
        decodePreview(payload).pipe(
          Effect.flatMap((input) => pages.preview(callerOf(fiber), input)),
          Effect.map((outcome) => {
            if (outcome.outcome !== "previewed") {
              return textResult(outcome.detail, true, { ...outcome });
            }
            const { png, ...facts } = outcome.preview;
            const console =
              facts.consoleMessages.length === 0
                ? "No console output."
                : facts.consoleMessages.map((entry) => `[${entry.level}] ${entry.text}`).join("\n");
            return new McpSchema.CallToolResult({
              isError: false,
              structuredContent: { ...facts },
              content: [
                {
                  type: "text",
                  text: `Preview at ${facts.width}px wide: the page needs ${facts.contentHeight}px of height (screenshot shows the top ${facts.capturedHeight}px).\n${console}`,
                },
                {
                  type: "image",
                  data: new Uint8Array(Buffer.from(png, "base64")),
                  mimeType: "image/png",
                },
              ],
            });
          }),
          Effect.catch((error) => Effect.succeed(invalidInput(error))),
        ),
      ),
  });
});

export const layer = Layer.fresh(
  Layer.effectDiscard(registerPageTools()).pipe(
    Layer.provideMerge(
      McpServer.layerHttp({
        name: "threadlines-pages",
        version: "1",
        path: MCP_PAGES_ROUTE_PATH,
        protocols: [McpProtocol.v2025_06_18],
      }).pipe(Layer.provide(AuthenticationLive)),
    ),
  ),
);
