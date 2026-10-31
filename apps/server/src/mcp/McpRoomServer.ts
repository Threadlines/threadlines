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
 *
 * The thread tools (child threads, threadTools.ts) and the schedule tools
 * (scheduleTools.ts) are served here too: they need the same caller identity
 * and the same per-runtime grant.
 */
import { agentInvitesMode, agentThreadsMode } from "@threadlines/shared/serverSettings";
import type { ThreadId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { McpProtocol, McpServer, Toolkit } from "effect/ai";
import { HttpRouter, HttpServerRequest, type HttpServerResponse } from "effect/http";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GUIDE_TOOL_NAME, SCHEDULE_TOOL_NAMES } from "./roomToolAccess.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { ComputerLinkClient } from "../links/ComputerLinkClient.ts";
import { ComputerLinks } from "../links/ComputerLinks.ts";
import { OutsideAgentSignIn } from "../outsideAgents/OutsideAgentSignIn.ts";
import { ComputerLinkRepository } from "../links/ComputerLinkRepository.ts";
import { makeThreadToolLinks } from "../links/threadToolLinks.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { ScheduledTasks } from "../scheduled/ScheduledTasks.ts";
import {
  listOnlyGrantedTools,
  MCP_ROOM_ROUTE_PATH,
  normalizeMcpHttpResponse,
  readBearerToken,
  unauthorizedMcpResponse,
} from "./McpHttpServer.ts";
import { type McpInvocationScope, mcpSessionRegistry } from "./McpSessionRegistry.ts";
import { limitReaches, makeOutsideToolLimits, outsideLimitDetail } from "./outsideToolLimit.ts";
import { makeRoomRequestRegistry } from "./roomRequests.ts";
import { makeRoomToolHandlers } from "./roomToolHandlers.ts";
import { McpRoomInvocation, RoomToolkit } from "./roomTools.ts";
import { makeGuideToolHandler } from "./guideToolHandlers.ts";
import { GuideToolkit } from "./guideTools.ts";
import { makeScheduleToolHandlers } from "./scheduleToolHandlers.ts";
import { ScheduleToolkit } from "./scheduleTools.ts";
import { makeThreadToolHandlers } from "./threadToolHandlers.ts";
import { ThreadToolkit } from "./threadTools.ts";
import { requestService } from "./requestService.ts";

/** Every tool the endpoint serves. */
const RoomEndpointToolkit = Toolkit.merge(
  RoomToolkit,
  ThreadToolkit,
  ScheduleToolkit,
  GuideToolkit,
);

type RoomEndpointToolName = keyof typeof RoomEndpointToolkit.tools;

/**
 * What each tool on this endpoint reaches, for outside work's limit: `own`,
 * only the caller's own thread or checkout; `project`, threads and tasks
 * beyond it; `changes`, it changes or starts something beyond its own
 * thread. The app guide is refused on its own.
 * Keyed by every tool, so a new one has to say.
 */
const ROOM_TOOL_REACH = {
  room_agents: "own",
  room_history: "own",
  room_diff: "own",
  room_available_agents: "own",
  room_ask: "changes",
  room_review: "changes",
  room_hand_off: "changes",
  room_invite: "changes",
  thread_agents: "project",
  thread_start: "changes",
  thread_list: "project",
  thread_read: "project",
  thread_send: "changes",
  thread_stop: "changes",
  schedule_list: "project",
  schedule_create: "changes",
  schedule_update: "changes",
  // Records that the caller's own scheduled run is done: its own thread only.
  scheduled_run_finish: "own",
} as const satisfies Record<
  Exclude<RoomEndpointToolName, typeof GUIDE_TOOL_NAME>,
  "own" | "project" | "changes"
>;
type ToolsReaching<R> = {
  [K in keyof typeof ROOM_TOOL_REACH]: (typeof ROOM_TOOL_REACH)[K] extends R ? K : never;
}[keyof typeof ROOM_TOOL_REACH];

const authenticate = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const limits = yield* makeOutsideToolLimits;
  return Effect.fn("McpRoomServer.authenticate")(function* (
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
    // The schedule tools follow "Agents can start threads", read live: off,
    // they aren't listed (and their handlers refuse a call anyway).
    const mode = yield* settings.getSettings.pipe(
      Effect.map(agentThreadsMode),
      Effect.orElseSucceed(() => "off" as const),
    );
    const listed: ReadonlySet<string> =
      mode === "off"
        ? new Set(
            [...scope.roomTools].filter(
              (tool) => !(SCHEDULE_TOOL_NAMES as ReadonlyArray<string>).includes(tool),
            ),
          )
        : scope.roomTools;
    // Read per call: outside work can limit a credential while it lives.
    const outsideLimit = yield* limits.forScope(scope);
    return yield* handler.pipe(
      Effect.provideService(
        McpRoomInvocation,
        outsideLimit === null ? scope : { ...scope, outsideLimit },
      ),
      Effect.map((response) => listOnlyGrantedTools(normalizeMcpHttpResponse(response), listed)),
    );
  });
});

const AuthenticationLive = HttpRouter.middleware<{
  provides: McpRoomInvocation;
}>()(authenticate).layer;

/** The handlers, bound to the running server's orchestration and git. */
const RoomToolHandlersLive = RoomEndpointToolkit.toLayer(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    const providers = yield* ProviderRegistry;
    const providerService = yield* ProviderService;
    const git = yield* GitVcsDriver;
    const settings = yield* ServerSettingsService;
    // Linked computers, when this server has them (docs/design/fleet.md).
    const linkClient = yield* Effect.serviceOption(ComputerLinkClient);
    const linkRepo = yield* Effect.serviceOption(ComputerLinkRepository);
    const identities = yield* Effect.serviceOption(RepositoryIdentityResolver);
    const links =
      Option.isSome(linkClient) && Option.isSome(linkRepo) && Option.isSome(identities)
        ? makeThreadToolLinks({
            client: linkClient.value,
            repo: linkRepo.value,
            identities: identities.value,
          })
        : undefined;
    // Requests outlive the HTTP calls waiting on them; they end with the server.
    const requests = makeRoomRequestRegistry(yield* Effect.scope);
    const readThread = (threadId: ThreadId) =>
      snapshots.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrUndefined), Effect.orDie);
    const readThreadShell = (threadId: ThreadId) =>
      snapshots.getThreadShellById(threadId).pipe(Effect.map(Option.getOrUndefined), Effect.orDie);
    const handlers = makeRoomToolHandlers({
      engine,
      readThread,
      readProjectRoot: (projectId) =>
        snapshots.getProjectShellById(projectId).pipe(
          Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
          Effect.orDie,
        ),
      // The provider snapshots: each instance's driver and model names.
      driverKindOf: (instanceId) =>
        providers.getProviders.pipe(
          Effect.map((all) => all.find((provider) => provider.instanceId === instanceId)?.driver),
        ),
      roomToolsOf: (sessionKey) =>
        providerService.listSessions().pipe(
          Effect.map(
            (sessions) => sessions.find((entry) => entry.threadId === sessionKey)?.roomTools,
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      modelNameOf: (selection) =>
        providers.getProviders.pipe(
          Effect.map((all) => {
            const model = all
              .find((provider) => provider.instanceId === selection.instanceId)
              ?.models.find((candidate) => candidate.slug === selection.model);
            return model?.shortName ?? model?.name ?? selection.model;
          }),
        ),
      threadTitleOf: (threadId) =>
        readThreadShell(threadId).pipe(
          Effect.map((thread) => thread?.title),
          Effect.orElseSucceed(() => undefined),
        ),
      providers: providers.getProviders,
      invitesMode: settings.getSettings.pipe(
        Effect.map(agentInvitesMode),
        Effect.orElseSucceed(() => "off" as const),
      ),
      git,
      requests,
    });
    // Scheduled tasks, when this server has them (docs/design/fleet.md, Part 6).
    const scheduledTasks = yield* Effect.serviceOption(ScheduledTasks);
    const threadHandlers = makeThreadToolHandlers({
      engine,
      readThread,
      readThreadShell,
      // The sidebar's snapshot, narrowed to one project: open threads only.
      listProjectThreads: (projectId) =>
        snapshots.getShellSnapshot().pipe(
          Effect.map((snapshot) =>
            snapshot.threads.filter((thread) => thread.projectId === projectId),
          ),
          Effect.orDie,
        ),
      readProject: (projectId) =>
        snapshots
          .getProjectShellById(projectId)
          .pipe(Effect.map(Option.getOrUndefined), Effect.orDie),
      providers: providers.getProviders,
      threadsMode: settings.getSettings.pipe(
        Effect.map(agentThreadsMode),
        Effect.orElseSucceed(() => "off" as const),
      ),
      git,
      requests,
      ...(links !== undefined ? { links } : {}),
      ...(Option.isSome(scheduledTasks)
        ? { scheduleAnswerWaiting: scheduledTasks.value.waitingThreadIds }
        : {}),
    });
    const scheduleHandlers = makeScheduleToolHandlers({
      scheduledTasks: Option.getOrUndefined(scheduledTasks),
      readThread,
      threadsMode: settings.getSettings.pipe(
        Effect.map(agentThreadsMode),
        Effect.orElseSucceed(() => "off" as const),
      ),
      providers: providers.getProviders,
      localTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    // The app guide reads this computer's values only as an answer shows them.
    const environment = yield* Effect.serviceOption(ServerEnvironment);
    // A read that fails leaves its value out of the answer.
    const orUndefined = <A, E>(read: Effect.Effect<A, E>) =>
      read.pipe(
        Effect.map((value): A | undefined => value),
        Effect.orElseSucceed(() => undefined),
      );
    const computerLinks = yield* Effect.serviceOption(ComputerLinks);
    const outsideAgents = yield* Effect.serviceOption(OutsideAgentSignIn);
    const guide = makeGuideToolHandler({
      computerName: Effect.sync(() =>
        Option.isSome(environment) ? environment.value.currentLabel() : "this computer",
      ),
      settings: orUndefined(settings.getSettings),
      linkedComputers: orUndefined(
        Effect.gen(function* () {
          const outbound = links === undefined ? [] : yield* links.computers;
          const inbound = Option.isSome(computerLinks)
            ? (yield* computerLinks.value.snapshot).inbound
            : [];
          const inboundByEnvironment = new Map(
            inbound.flatMap((link) =>
              link.environmentId === null ? [] : [[link.environmentId, link]],
            ),
          );
          const fromOutbound = outbound.map((computer) => {
            const here = inboundByEnvironment.get(computer.environmentId);
            return {
              name: computer.label,
              reachable: computer.reachable,
              theirAgentsHere:
                here === undefined
                  ? null
                  : { access: here.access, maxRuntimeMode: here.maxRuntimeMode },
              ourAgentsThere:
                computer.descriptor === null
                  ? null
                  : {
                      access: computer.descriptor.access,
                      maxRuntimeMode: computer.descriptor.maxRuntimeMode,
                      fresh: computer.reachable,
                    },
            };
          });
          const known = new Set(outbound.map((computer) => computer.environmentId));
          const inboundOnly = inbound
            .filter((link) => link.environmentId === null || !known.has(link.environmentId))
            .map((link) => ({
              name: link.label,
              reachable: false,
              theirAgentsHere: { access: link.access, maxRuntimeMode: link.maxRuntimeMode },
              ourAgentsThere: null,
            }));
          return [...fromOutbound, ...inboundOnly];
        }),
      ),
      providers: providers.getProviders.pipe(
        Effect.map((all) =>
          all.map((provider) => ({
            name: provider.displayName ?? provider.instanceId,
            enabled: provider.enabled,
            signedIn:
              provider.auth.status === "authenticated"
                ? true
                : provider.auth.status === "unauthenticated"
                  ? false
                  : null,
          })),
        ),
      ),
      // The Agents group as Settings shows it: its first snapshot is now.
      outsideAgents: Option.isSome(outsideAgents)
        ? orUndefined(
            outsideAgents.value.changes.pipe(
              Stream.take(1),
              Stream.runHead,
              Effect.map(Option.getOrUndefined),
              Effect.map((snapshot) =>
                snapshot?.connections.map((connection) => ({ name: connection.name })),
              ),
            ),
          )
        : Effect.succeed(undefined),
      scheduledTasks: Option.isSome(scheduledTasks)
        ? orUndefined(
            scheduledTasks.value.snapshot.pipe(
              Effect.map(({ tasks }) => ({
                active: tasks.filter((task) => task.status === "active").length,
                paused: tasks.filter((task) => task.status === "paused").length,
              })),
            ),
          )
        : Effect.succeed(undefined),
    });
    const caller = requestService(McpRoomInvocation);
    type Refused = { readonly outcome: "refused"; readonly detail: string };
    /**
     * Every call goes through one of these, by what its tool reaches
     * (ROOM_TOOL_REACH, checked by type). While outside work limits the
     * caller (outsideToolLimit.ts): a read of its own thread or checkout goes
     * through; a read beyond it stays inside the limit's projects (the
     * handlers drop linked computers themselves); a change is refused.
     */
    const own = <A>(
      _tool: ToolsReaching<"own">,
      run: (scope: McpInvocationScope) => Effect.Effect<A>,
    ) => Effect.flatMap(caller, run);
    const changes = <A>(
      _tool: ToolsReaching<"changes">,
      run: (scope: McpInvocationScope) => Effect.Effect<A>,
    ) =>
      Effect.flatMap(caller, (scope): Effect.Effect<A | Refused> =>
        scope.outsideLimit === undefined
          ? run(scope)
          : Effect.succeed({ outcome: "refused", detail: outsideLimitDetail(scope.outsideLimit) }),
      );
    const projectRead = <A>(
      _tool: ToolsReaching<"project">,
      run: (scope: McpInvocationScope) => Effect.Effect<A>,
      refusedAs: (detail: string) => A,
    ) =>
      Effect.flatMap(caller, (scope) =>
        Effect.gen(function* () {
          const limit = scope.outsideLimit;
          if (limit === undefined) return yield* run(scope);
          const shell = yield* readThreadShell(scope.threadId);
          return shell !== undefined && limitReaches(limit, shell.projectId)
            ? yield* run(scope)
            : refusedAs(outsideLimitDetail(limit));
        }),
      );
    return {
      room_agents: () => own("room_agents", handlers.room_agents),
      room_history: (input) => own("room_history", (scope) => handlers.room_history(scope, input)),
      room_diff: (input) => own("room_diff", (scope) => handlers.room_diff(scope, input)),
      room_ask: (input) => changes("room_ask", (scope) => handlers.room_ask(scope, input)),
      room_review: (input) => changes("room_review", (scope) => handlers.room_review(scope, input)),
      room_hand_off: (input) =>
        changes("room_hand_off", (scope) => handlers.room_hand_off(scope, input)),
      room_available_agents: () => own("room_available_agents", handlers.room_available_agents),
      room_invite: (input) => changes("room_invite", (scope) => handlers.room_invite(scope, input)),
      thread_agents: (input) =>
        projectRead(
          "thread_agents",
          (scope) => threadHandlers.thread_agents(scope, input),
          (detail) => ({ outcome: "refused", detail, agents: [], unavailable: [] }),
        ),
      thread_start: (input) =>
        changes("thread_start", (scope) => threadHandlers.thread_start(scope, input)),
      thread_list: (input) =>
        projectRead(
          "thread_list",
          (scope) => threadHandlers.thread_list(scope, input),
          (detail) => ({ outcome: "refused", detail, threads: [] }),
        ),
      thread_read: (input) =>
        projectRead(
          "thread_read",
          (scope) => threadHandlers.thread_read(scope, input),
          (detail) => ({ outcome: "refused", detail, messages: [], next: null, more: false }),
        ),
      thread_send: (input) =>
        changes("thread_send", (scope) => threadHandlers.thread_send(scope, input)),
      thread_stop: (input) =>
        changes("thread_stop", (scope) => threadHandlers.thread_stop(scope, input)),
      schedule_list: (input) =>
        projectRead(
          "schedule_list",
          (scope) => scheduleHandlers.schedule_list(scope, input),
          (detail) => ({ outcome: "refused", detail, tasks: [] }),
        ),
      schedule_create: (input) =>
        changes("schedule_create", (scope) => scheduleHandlers.schedule_create(scope, input)),
      schedule_update: (input) =>
        changes("schedule_update", (scope) => scheduleHandlers.schedule_update(scope, input)),
      scheduled_run_finish: (input) =>
        own("scheduled_run_finish", (scope) => scheduleHandlers.scheduled_run_finish(scope, input)),
      // Listed only to runtimes granted it; a call from any other is refused
      // too (a review runtime reads the checkout and nothing else). Refused
      // while outside work limits the caller: it reads app-wide settings,
      // linked computers and connection names.
      app_guide: (input) =>
        Effect.flatMap(caller, (scope) =>
          scope.outsideLimit !== undefined
            ? Effect.succeed({
                outcome: "refused" as const,
                answer: outsideLimitDetail(scope.outsideLimit),
              })
            : scope.roomTools.has(GUIDE_TOOL_NAME)
              ? guide(input)
              : Effect.succeed({
                  outcome: "refused" as const,
                  answer: "The Threadlines guide isn't available to you here.",
                }),
        ),
    };
  }),
);

export const layer = Layer.fresh(
  McpServer.toolkit(RoomEndpointToolkit).pipe(
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
