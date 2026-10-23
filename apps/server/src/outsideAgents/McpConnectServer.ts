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
import type { ThreadId } from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import {
  listOnlyGrantedTools,
  normalizeMcpHttpResponse,
  readBearerToken,
} from "../mcp/McpHttpServer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBootstrap } from "../orchestration/Services/ThreadBootstrap.ts";
import { ThreadSearch } from "../orchestration/Services/ThreadSearch.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ScheduledTasks } from "../scheduled/ScheduledTasks.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { makeConnectLimits } from "./connectLimits.ts";
import { makeConnectToolHandlers } from "./connectToolHandlers.ts";
import {
  ConnectToolkit,
  McpConnectInvocation,
  SeeToolkit,
  START_ONLY_TOOLS,
} from "./connectTools.ts";
import {
  OUTSIDE_AGENT_MCP_PATH,
  OutsideAgentConnections,
  outsideAgentRequestOrigin,
  outsideAgentResource,
} from "./OutsideAgentConnections.ts";
import { OutsideAgentRequests } from "./OutsideAgentRequests.ts";

/** What a `see` connection lists, and what a `start` one does. */
const SEE_TOOLS: ReadonlySet<string> = new Set(Object.keys(SeeToolkit.tools));
const ALL_TOOLS: ReadonlySet<string> = new Set([...SEE_TOOLS, ...START_ONLY_TOOLS]);

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
    const listed =
      grant === null ? new Set<string>() : grant.access === "start" ? ALL_TOOLS : SEE_TOOLS;
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
    const connections = yield* OutsideAgentConnections;
    const engine = yield* OrchestrationEngineService;
    const bootstrap = yield* ThreadBootstrap;
    const snapshots = yield* ProjectionSnapshotQuery;
    const providers = yield* ProviderRegistry;
    const settings = yield* ServerSettingsService;
    const git = yield* GitVcsDriver;
    const requests = yield* OutsideAgentRequests;
    const search = yield* Effect.serviceOption(ThreadSearch);
    // Scheduled tasks, when this server has them: their cards waiting for
    // the user count in a thread's status.
    const scheduledTasks = yield* Effect.serviceOption(ScheduledTasks);
    const handlers = yield* makeConnectToolHandlers({
      connections,
      engine,
      bootstrap,
      shellSnapshot: snapshots.getShellSnapshot().pipe(Effect.orDie),
      readProject: (projectId) =>
        snapshots
          .getProjectShellById(projectId)
          .pipe(Effect.map(Option.getOrUndefined), Effect.orDie),
      readThread: (threadId) =>
        snapshots
          .getThreadDetailById(threadId)
          .pipe(Effect.map(Option.getOrUndefined), Effect.orDie),
      status: {
        subscribeEvents: engine.subscribeDomainEvents,
        readShell: (threadId) =>
          snapshots
            .getThreadShellById(threadId)
            .pipe(Effect.map(Option.getOrUndefined), Effect.orDie),
        scheduleAnswerWaiting: Option.isSome(scheduledTasks)
          ? scheduledTasks.value.waitingThreadIds
          : Effect.succeed(new Set<ThreadId>()),
        scheduleAnswerChanges: Option.isSome(scheduledTasks)
          ? scheduledTasks.value.changes.pipe(Stream.ignore)
          : Stream.empty,
      },
      providers: providers.getProviders,
      userDefaultModel: settings.getSettings.pipe(
        Effect.map((current) => current.newThreadModelSelection),
        Effect.orElseSucceed(() => null),
      ),
      git,
      ...(Option.isSome(search)
        ? {
            searchThreads: (input) =>
              search.value.search(input).pipe(
                Effect.map((result) => result.matches.map((match) => match.threadId)),
                Effect.orElseSucceed(() => []),
              ),
          }
        : {}),
      requests,
      limits: makeConnectLimits(),
    });
    const counted = yield* makeToolCallCounts;
    const caller = Effect.service(McpConnectInvocation);
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
