/**
 * The device tools' endpoint, `threadlines_device` at `/mcp/device`
 * (docs/design/devices.md).
 *
 * Its own MCP server, like McpCommandsServer: a provider lists it only for
 * sessions started with `deviceTools`, and Codex approves calls per server.
 * The same bearer credentials as `/mcp` (McpSessionRegistry); a credential
 * reaches this endpoint only if it carries the `device` grant, and each call
 * checks again that "Use devices" and "Agents can use devices" are still on.
 *
 * Hand-registered rather than a toolkit so `device_screenshot` can answer
 * with an MCP image block instead of base64 the model cannot see.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/ai";
import { HttpRouter, HttpServerRequest, type HttpServerResponse } from "effect/http";

import { DeviceService } from "../device/DeviceService.ts";
import { deviceClose, deviceList, deviceOpen, deviceScreenshot } from "./deviceToolHandlers.ts";
import { makeOutsideToolLimits } from "./outsideToolLimit.ts";
import {
  DEVICE_CLOSE_TOOL_NAME,
  DEVICE_LIST_TOOL_NAME,
  DEVICE_OPEN_TOOL_NAME,
  DEVICE_SCREENSHOT_TOOL_NAME,
  DEVICE_TOOLS,
  DeviceToolListInput,
} from "./deviceTools.ts";
import {
  DeviceToolCloseInput,
  DeviceToolOpenInput,
  DeviceToolTargetInput,
} from "@threadlines/contracts";
import {
  MCP_DEVICE_ROUTE_PATH,
  normalizeMcpHttpResponse,
  readBearerToken,
  unauthorizedMcpResponse,
} from "./McpHttpServer.ts";
import { type McpInvocationScope, mcpSessionRegistry } from "./McpSessionRegistry.ts";

/** Which runtime a device tool call came from, with the outside-work limit read for this request. */
export class McpDeviceInvocation extends Context.Service<McpDeviceInvocation, McpInvocationScope>()(
  "@threadlines/server/mcp/McpDeviceInvocation",
) {}

const authenticate = Effect.gen(function* () {
  const limits = yield* makeOutsideToolLimits;
  return Effect.fn("McpDeviceServer.authenticate")(function* (
    handler: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      Types.unhandled,
      McpDeviceInvocation
    >,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const scope = yield* mcpSessionRegistry.resolve(readBearerToken(request));
    if (scope === null || !scope.device) {
      return unauthorizedMcpResponse;
    }
    // Read on every request: outside work can arrive in a session that started without it.
    const outsideLimit = yield* limits.forScope(scope);
    return yield* handler.pipe(
      Effect.provideService(McpDeviceInvocation, {
        ...scope,
        ...(outsideLimit !== null ? { outsideLimit } : {}),
      }),
      Effect.map(normalizeMcpHttpResponse),
    );
  });
});

const AuthenticationLive = HttpRouter.middleware<{
  provides: McpDeviceInvocation;
}>()(authenticate).layer;

const describe = (tool: Tool.Any) =>
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

/** A failure the model can read: the error's own words. Interrupts and defects stay what they are. */
const failureResult = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const error = cause.reasons.find(Cause.isFailReason)?.error;
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : "The device tool failed.";
  return Effect.succeed(textResult(message, true));
};

const screenshotResult = (shot: {
  readonly device: { readonly name: string; readonly version: string };
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}) =>
  new McpSchema.CallToolResult({
    isError: false,
    structuredContent: { width: shot.width, height: shot.height },
    content: [
      {
        type: "text",
        text: `Screenshot of ${shot.device.name} (${shot.device.version}), ${shot.width}x${shot.height} pixels.`,
      },
      { type: "image", data: shot.png, mimeType: "image/png" },
    ],
  });

const registerDeviceTools = Effect.fn("McpDeviceServer.registerDeviceTools")(function* () {
  const server = yield* McpServer.McpServer;
  const devices = yield* DeviceService;
  const decodeList = Schema.decodeUnknownEffect(DeviceToolListInput);
  const decodeOpen = Schema.decodeUnknownEffect(DeviceToolOpenInput);
  const decodeTarget = Schema.decodeUnknownEffect(DeviceToolTargetInput);
  const decodeClose = Schema.decodeUnknownEffect(DeviceToolCloseInput);

  // The caller comes off the request's own fiber: a hand-registered handler
  // does not run under the router middleware that provides it.
  const callerOf = (fiber: { readonly context: Context.Context<never> }) =>
    Context.getUnsafe(fiber.context as Context.Context<McpDeviceInvocation>, McpDeviceInvocation);

  const badArguments = (error: unknown) =>
    textResult(
      `The arguments do not fit the tool's schema: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );

  const handlers: Record<
    string,
    (
      caller: McpInvocationScope,
      payload: unknown,
    ) => Effect.Effect<McpSchema.CallToolResult, never, DeviceService>
  > = {
    [DEVICE_LIST_TOOL_NAME]: (caller, payload) =>
      decodeList(payload ?? {}).pipe(
        Effect.matchEffect({
          onFailure: (error) => Effect.succeed(badArguments(error)),
          onSuccess: (input) =>
            deviceList(caller, input).pipe(
              Effect.map((result) =>
                textResult(JSON.stringify(result, null, 2), false, { ...result }),
              ),
              Effect.catchCause(failureResult),
            ),
        }),
      ),
    [DEVICE_OPEN_TOOL_NAME]: (caller, payload) =>
      decodeOpen(payload ?? {}).pipe(
        Effect.matchEffect({
          onFailure: (error) => Effect.succeed(badArguments(error)),
          onSuccess: (input) =>
            deviceOpen(caller, input).pipe(
              Effect.map((result) => textResult(result.quickStart, false, { ...result })),
              Effect.catchCause(failureResult),
            ),
        }),
      ),
    [DEVICE_SCREENSHOT_TOOL_NAME]: (caller, payload) =>
      decodeTarget(payload ?? {}).pipe(
        Effect.matchEffect({
          onFailure: (error) => Effect.succeed(badArguments(error)),
          onSuccess: (input) =>
            deviceScreenshot(caller, input).pipe(
              Effect.map(screenshotResult),
              Effect.catchCause(failureResult),
            ),
        }),
      ),
    [DEVICE_CLOSE_TOOL_NAME]: (caller, payload) =>
      decodeClose(payload ?? {}).pipe(
        Effect.matchEffect({
          onFailure: (error) => Effect.succeed(badArguments(error)),
          onSuccess: (input) =>
            deviceClose(caller, input).pipe(
              Effect.as(textResult("Closed.", false, {})),
              Effect.catchCause(failureResult),
            ),
        }),
      ),
  };

  for (const tool of DEVICE_TOOLS) {
    const handle = handlers[tool.name]!;
    yield* server.addTool({
      tool: describe(tool),
      annotations: tool.annotations,
      handle: (payload) =>
        Effect.withFiber((fiber) =>
          handle(callerOf(fiber), payload).pipe(Effect.provideService(DeviceService, devices)),
        ),
    });
  }
});

export const layer = Layer.fresh(
  Layer.effectDiscard(registerDeviceTools()).pipe(
    Layer.provideMerge(
      McpServer.layerHttp({
        name: "threadlines-device",
        version: "1",
        path: MCP_DEVICE_ROUTE_PATH,
        protocols: [McpProtocol.v2025_06_18],
      }).pipe(Layer.provide(AuthenticationLive)),
    ),
  ),
);
