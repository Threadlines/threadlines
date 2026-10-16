/**
 * `ask_user_to_run`'s endpoint, `threadlines_commands` at `/mcp/commands`
 * (docs/terminal-command-runs.md).
 *
 * Its own MCP server for the same reason as McpPagesServer: Codex approves
 * tool calls per server, and this one may run without asking (it only shows
 * the user a card) while the browser tools may not. A fresh, isolated layer,
 * so its registry never lists another endpoint's tools.
 *
 * The same bearer credentials as `/mcp` (McpSessionRegistry); a credential
 * reaches this endpoint only if it carries the `commands` grant.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, type HttpServerResponse } from "effect/unstable/http";

import { CommandRuns } from "../commandRuns/CommandRuns.ts";
import { AskUserToRunParameters, AskUserToRunTool } from "./commandTools.ts";
import {
  MCP_COMMANDS_ROUTE_PATH,
  normalizeMcpHttpResponse,
  readBearerToken,
  unauthorizedMcpResponse,
} from "./McpHttpServer.ts";
import { type McpInvocationScope, mcpSessionRegistry } from "./McpSessionRegistry.ts";

/** Which runtime a command tool call came from: the full credential scope. */
export class McpCommandsInvocation extends Context.Service<
  McpCommandsInvocation,
  McpInvocationScope
>()("@threadlines/server/mcp/McpCommandsInvocation") {}

const authenticate = Effect.succeed(
  Effect.fn("McpCommandsServer.authenticate")(function* (
    handler: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      Types.unhandled,
      McpCommandsInvocation
    >,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const scope = yield* mcpSessionRegistry.resolve(readBearerToken(request));
    if (scope === null || !scope.commands) {
      return unauthorizedMcpResponse;
    }
    return yield* handler.pipe(
      Effect.provideService(McpCommandsInvocation, scope),
      Effect.map(normalizeMcpHttpResponse),
    );
  }),
);

const AuthenticationLive = HttpRouter.middleware<{
  provides: McpCommandsInvocation;
}>()(authenticate).layer;

const toolDescription = new McpSchema.Tool({
  name: AskUserToRunTool.name,
  description: Tool.getDescription(AskUserToRunTool),
  inputSchema: Tool.getJsonSchema(AskUserToRunTool),
  annotations: {
    ...Context.getOption(AskUserToRunTool.annotations, Tool.Title).pipe(
      Option.map((title) => ({ title })),
      Option.getOrUndefined,
    ),
    readOnlyHint: Context.get(AskUserToRunTool.annotations, Tool.Readonly),
    destructiveHint: Context.get(AskUserToRunTool.annotations, Tool.Destructive),
    idempotentHint: Context.get(AskUserToRunTool.annotations, Tool.Idempotent),
    openWorldHint: Context.get(AskUserToRunTool.annotations, Tool.OpenWorld),
  },
});

const textResult = (text: string, isError: boolean, structured?: Record<string, unknown>) =>
  new McpSchema.CallToolResult({
    isError,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    content: [{ type: "text", text }],
  });

const registerCommandTools = Effect.fn("McpCommandsServer.registerCommandTools")(function* () {
  const server = yield* McpServer.McpServer;
  const commandRuns = yield* CommandRuns;
  const decode = Schema.decodeUnknownEffect(AskUserToRunParameters);

  // The caller comes off the request's own fiber: a hand-registered handler
  // does not run under the router middleware that provides it.
  const callerOf = (fiber: { readonly context: Context.Context<never> }) =>
    Context.getUnsafe(
      fiber.context as Context.Context<McpCommandsInvocation>,
      McpCommandsInvocation,
    );

  yield* server.addTool({
    tool: toolDescription,
    annotations: AskUserToRunTool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) =>
        decode(payload).pipe(
          Effect.flatMap((input) => commandRuns.request(callerOf(fiber), input)),
          Effect.map((outcome) =>
            textResult(outcome.detail, outcome.outcome !== "shown", { ...outcome }),
          ),
          Effect.catch((error) =>
            Effect.succeed(
              textResult(
                `The arguments do not fit the tool's schema: ${error instanceof Error ? error.message : String(error)}`,
                true,
              ),
            ),
          ),
        ),
      ),
  });
});

export const layer = Layer.fresh(
  Layer.effectDiscard(registerCommandTools()).pipe(
    Layer.provideMerge(
      McpServer.layerHttp({
        name: "threadlines-commands",
        version: "1",
        path: MCP_COMMANDS_ROUTE_PATH,
        protocols: [McpProtocol.v2025_06_18],
      }).pipe(Layer.provide(AuthenticationLive)),
    ),
  ),
);
