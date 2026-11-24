/**
 * The tool endpoints an eval's agent talks to: production's room and browser
 * MCP endpoints (same tool list, descriptions, per-runtime filtering and
 * sign-in check against the shared credential registry) with canned handlers.
 * Agent pages and command requests are off in evals, so their endpoints and
 * instructions are both absent.
 */
import * as http from "node:http";

import type { RuntimeMode } from "@threadlines/contracts";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { HttpRouter, HttpServer } from "effect/http";

import * as McpHttpServer from "../../src/mcp/McpHttpServer.ts";
import * as McpRoomServer from "../../src/mcp/McpRoomServer.ts";
import { ProjectionSnapshotQuery } from "../../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../src/serverSettings.ts";
import {
  makeCannedRoomHandlers,
  refusingBrowserHandlers,
  type CannedAnswers,
  type ToolCall,
} from "./cannedTools.ts";

export interface EvalToolServer {
  readonly port: number;
  /** Every tool call the agent made, in order. */
  readonly calls: ReadonlyArray<ToolCall>;
  readonly close: () => Promise<void>;
}

export async function startEvalToolServer(input: {
  readonly answers?: CannedAnswers;
  /** The eval thread's access: a thread it starts gets at most this. */
  readonly runtimeMode: RuntimeMode;
  readonly serverSettings: Parameters<typeof ServerSettingsService.layerTest>[0];
}): Promise<EvalToolServer> {
  const calls: Array<ToolCall> = [];
  const routes = Layer.mergeAll(
    McpRoomServer.makeLayer(
      makeCannedRoomHandlers(calls, input.answers, { runtimeMode: input.runtimeMode }),
    ),
    McpHttpServer.makeLayer(refusingBrowserHandlers),
  );
  const layer = HttpRouter.serve(routes, { disableLogger: true }).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(() => http.createServer(), { host: "127.0.0.1", port: 0 }),
    ),
    Layer.provide(ServerSettingsService.layerTest(input.serverSettings)),
    // Read to limit an outside agent's credential; an eval's agent has none,
    // and its thread no outside work.
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: () => Effect.succeed(Option.none()),
        getThreadDetailById: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const address = await runtime.runPromise(
    Effect.map(Effect.service(HttpServer.HttpServer), (server) => server.address),
  );
  if (address._tag === "UnixPathAddress") throw new Error("The eval tool server has no TCP port.");
  return { port: address.port, calls, close: () => runtime.dispose() };
}
