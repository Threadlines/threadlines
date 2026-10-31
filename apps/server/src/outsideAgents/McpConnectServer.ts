/**
 * The outside agents' endpoint, `/mcp/connect` (docs/design/outside-agents.md,
 * "The MCP server"): coding agents running outside Threadlines, once the user
 * approved them, use the tools in connectTools.ts here.
 *
 * Its own MCP server, built fresh like the room endpoint (McpRoomServer), so
 * its tools are listed on no other endpoint and no other endpoint's here.
 *
 * Its middleware accepts one credential: an outside agent's access token,
 * checked by OutsideAgentConnections against the resource the request came
 * to. It never calls ServerAuth, so a cookie, an owner bearer, an agent's
 * session token or a dev-origin session reaches no tool here; anything but a
 * live token is a 401 pointing the agent at the sign-in. A request from off
 * this computer (not loopback, through a proxy, or under another Host) is a
 * 421, before any token is looked at.
 *
 * `tools/list` shows what the connection's live grant allows, read again at
 * every listing; every handler checks the grant again anyway.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Types from "effect/Types";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

import {
  listOnlyGrantedTools,
  normalizeMcpHttpResponse,
  readBearerToken,
} from "../mcp/McpHttpServer.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import { makeConnectToolDeps } from "./connectToolDeps.ts";
import { makeConnectToolHandlers } from "./connectToolHandlers.ts";
import { ConnectToolkit, listedToolsFor, McpConnectInvocation } from "./connectTools.ts";
import {
  OUTSIDE_AGENT_MCP_PATH,
  OutsideAgentConnections,
  outsideAgentRequestOrigin,
  outsideAgentResource,
} from "./OutsideAgentConnections.ts";
import { requestService } from "../mcp/requestService.ts";

/** A request from off this computer: approval promised the agent runs on it. */
const misdirectedResponse = (port: number | null) =>
  HttpServerResponse.text(
    port === null
      ? "Agents can connect to Threadlines only from this computer."
      : `Agents can connect to Threadlines only from this computer, at http://127.0.0.1:${port}${OUTSIDE_AGENT_MCP_PATH}.`,
    { status: 421, headers: { "cache-control": "no-store" } },
  );

/** No live token: the agent signs in (again), starting from the resource metadata. */
const unauthorizedResponse = (origin: string) =>
  HttpServerResponse.jsonUnsafe(
    {
      error: "invalid_token",
      error_description: "Sign in to Threadlines from your agent, then approve it in Threadlines.",
    },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${OUTSIDE_AGENT_MCP_PATH}"`,
      },
    },
  );

const authenticate = Effect.gen(function* () {
  const connections = yield* OutsideAgentConnections;
  // The port a loopback Host must name: the one this server listens on.
  const address = (yield* HttpServer.HttpServer).address;
  const port = typeof address !== "string" && "port" in address ? address.port : null;
  return Effect.fn("McpConnectServer.authenticate")(function* (
    handler: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      Types.unhandled,
      McpConnectInvocation
    >,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const origin = port === null ? null : outsideAgentRequestOrigin(request, port);
    if (origin === null) {
      return misdirectedResponse(port);
    }
    const token = readBearerToken(request);
    const caller =
      token.length === 0
        ? null
        : yield* connections.authenticate({ token, resource: outsideAgentResource(origin) });
    if (caller === null) {
      return unauthorizedResponse(origin);
    }
    const response = yield* handler.pipe(Effect.provideService(McpConnectInvocation, caller));
    const grant = yield* connections.grant(caller.connectionId);
    const listed = listedToolsFor(grant?.access ?? null);
    return listOnlyGrantedTools(normalizeMcpHttpResponse(response), listed);
  });
});

const AuthenticationLive = HttpRouter.middleware<{
  provides: McpConnectInvocation;
}>()(authenticate).layer;

/**
 * Telemetry: how many calls each tool answered with each outcome, sent once a
 * day (and when the server stops) as `outside_agent.tool_calls`, one event
 * per tool and outcome. Never a thread's content or an agent's name.
 */
const makeToolCallCounts = Effect.gen(function* () {
  const analytics = yield* Effect.serviceOption(AnalyticsService);
  const counts = new Map<string, { tool: string; outcome: string; count: number }>();
  const report = Effect.suspend(() => {
    const entries = [...counts.values()];
    counts.clear();
    return Option.isNone(analytics)
      ? Effect.void
      : Effect.forEach(entries, (entry) => analytics.value.record(TOOL_CALLS_EVENT, entry), {
          discard: true,
        });
  });
  yield* report.pipe(Effect.delay(Duration.days(1)), Effect.forever, Effect.forkScoped);
  yield* Effect.addFinalizer(() => report);
  return <A extends { readonly outcome: string }, R>(
    tool: string,
    call: Effect.Effect<A, never, R>,
  ) =>
    Effect.tap(call, (result) =>
      Effect.sync(() => {
        const key = `${tool}\u0000${result.outcome}`;
        const entry = counts.get(key) ?? { tool, outcome: result.outcome, count: 0 };
        counts.set(key, { ...entry, count: entry.count + 1 });
      }),
    );
});

const TOOL_CALLS_EVENT = "outside_agent.tool_calls";

/** The handlers, bound to the running server's orchestration, settings and git. */
const ConnectToolHandlersLive = ConnectToolkit.toLayer(
  Effect.gen(function* () {
    const handlers = yield* makeConnectToolHandlers(yield* makeConnectToolDeps);
    const counted = yield* makeToolCallCounts;
    const caller = requestService(McpConnectInvocation);
    return {
      projects: () => counted("projects", Effect.flatMap(caller, handlers.projects)),
      agents: (input) =>
        counted(
          "agents",
          Effect.flatMap(caller, (connection) => handlers.agents(connection, input)),
        ),
      threads_list: (input) =>
        counted(
          "threads_list",
          Effect.flatMap(caller, (connection) => handlers.threads_list(connection, input)),
        ),
      thread_read: (input) =>
        counted(
          "thread_read",
          Effect.flatMap(caller, (connection) => handlers.thread_read(connection, input)),
        ),
      thread_wait: (input) =>
        counted(
          "thread_wait",
          Effect.flatMap(caller, (connection) => handlers.thread_wait(connection, input)),
        ),
      inbox: (input) =>
        counted(
          "inbox",
          Effect.flatMap(caller, (connection) => handlers.inbox(connection, input)),
        ),
      thread_changes: (input) =>
        counted(
          "thread_changes",
          Effect.flatMap(caller, (connection) => handlers.thread_changes(connection, input)),
        ),
      thread_start: (input) =>
        counted(
          "thread_start",
          Effect.flatMap(caller, (connection) => handlers.thread_start(connection, input)),
        ),
      thread_send: (input) =>
        counted(
          "thread_send",
          Effect.flatMap(caller, (connection) => handlers.thread_send(connection, input)),
        ),
      thread_stop: (input) =>
        counted(
          "thread_stop",
          Effect.flatMap(caller, (connection) => handlers.thread_stop(connection, input)),
        ),
      thread_answer: (input) =>
        counted(
          "thread_answer",
          Effect.flatMap(caller, (connection) => handlers.thread_answer(connection, input)),
        ),
    };
  }),
);

export const layer = Layer.fresh(
  McpServer.toolkit(ConnectToolkit).pipe(
    Layer.provide(ConnectToolHandlersLive),
    Layer.provideMerge(
      McpServer.layerHttp({
        name: "threadlines",
        version: "1",
        path: OUTSIDE_AGENT_MCP_PATH,
        protocols: [McpProtocol.v2025_06_18],
      }).pipe(Layer.provide(AuthenticationLive)),
    ),
  ),
);
