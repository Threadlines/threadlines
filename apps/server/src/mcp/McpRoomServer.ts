/**
 * The room tools' endpoint, `threadlines_room` at `/mcp/room`
 * (docs/design/rooms-slice-2.md, Part B).
 *
 * Its own MCP server rather than more tools on `/mcp`: that server's tool list
 * is shared by every client, so every session in every thread would carry
 * room tools. Built as a fresh, isolated layer on purpose: two
 * `McpServer.layerHttp` layers built from one memo map share a single
 * `McpServer` registry, and each endpoint would list the other's tools.
 *
 * The same bearer credentials as `/mcp` (McpSessionRegistry); a credential
 * reaches this endpoint only if it carries room tools, and each handler still
 * checks that its caller may use that tool.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Types from "effect/Types";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, type HttpServerResponse } from "effect/unstable/http";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  MCP_ROOM_ROUTE_PATH,
  normalizeMcpHttpResponse,
  readBearerToken,
  unauthorizedMcpResponse,
} from "./McpHttpServer.ts";
import { mcpSessionRegistry } from "./McpSessionRegistry.ts";
import { makeRoomRequestRegistry } from "./roomRequests.ts";
import { makeRoomToolHandlers } from "./roomToolHandlers.ts";
import { McpRoomInvocation, RoomToolkit } from "./roomTools.ts";

const authenticate = Effect.succeed(
  Effect.fn("McpRoomServer.authenticate")(function* (
    handler: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      Types.unhandled,
      McpRoomInvocation
    >,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const scope = yield* mcpSessionRegistry.resolve(readBearerToken(request));
    if (scope === null || scope.roomTools.size === 0) {
      return unauthorizedMcpResponse;
    }
    return yield* handler.pipe(
      Effect.provideService(McpRoomInvocation, scope),
      Effect.map(normalizeMcpHttpResponse),
    );
  }),
);

const AuthenticationLive = HttpRouter.middleware<{
  provides: McpRoomInvocation;
}>()(authenticate).layer;

/** The handlers, bound to the running server's orchestration and git. */
const RoomToolHandlersLive = RoomToolkit.toLayer(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    const instances = yield* ProviderInstanceRegistry;
    const git = yield* GitVcsDriver;
    // Requests outlive the HTTP calls waiting on them; they end with the server.
    const requests = makeRoomRequestRegistry(yield* Effect.scope);
    const handlers = makeRoomToolHandlers({
      engine,
      readThread: (threadId) =>
        snapshots
          .getThreadDetailById(threadId)
          .pipe(Effect.map(Option.getOrUndefined), Effect.orDie),
      readProjectRoot: (projectId) =>
        snapshots.getProjectShellById(projectId).pipe(
          Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
          Effect.orDie,
        ),
      driverKindOf: (instanceId) =>
        instances.getInstance(instanceId).pipe(Effect.map((instance) => instance?.driverKind)),
      modelNameOf: (selection) =>
        Effect.gen(function* () {
          const instance = yield* instances.getInstance(selection.instanceId);
          if (instance === undefined) {
            return selection.model;
          }
          const snapshot = yield* instance.snapshot.getSnapshot;
          const model = snapshot.models.find((candidate) => candidate.slug === selection.model);
          return model?.shortName ?? model?.name ?? selection.model;
        }),
      git,
      requests,
    });
    const caller = Effect.service(McpRoomInvocation);
    return {
      room_agents: () => Effect.flatMap(caller, handlers.room_agents),
      room_history: (input) =>
        Effect.flatMap(caller, (scope) => handlers.room_history(scope, input)),
      room_diff: (input) => Effect.flatMap(caller, (scope) => handlers.room_diff(scope, input)),
      room_ask: (input) => Effect.flatMap(caller, (scope) => handlers.room_ask(scope, input)),
      room_review: (input) => Effect.flatMap(caller, (scope) => handlers.room_review(scope, input)),
      room_hand_off: (input) =>
        Effect.flatMap(caller, (scope) => handlers.room_hand_off(scope, input)),
    };
  }),
);

export const layer = Layer.fresh(
  McpServer.toolkit(RoomToolkit).pipe(
    Layer.provide(RoomToolHandlersLive),
    Layer.provideMerge(
      McpServer.layerHttp({
        name: "threadlines-room",
        version: "1",
        path: MCP_ROOM_ROUTE_PATH,
        protocols: [McpProtocol.v2025_06_18],
      }).pipe(Layer.provide(AuthenticationLive)),
    ),
  ),
);
