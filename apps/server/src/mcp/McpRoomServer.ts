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
import { mcpSessionRegistry } from "./McpSessionRegistry.ts";
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

const authenticate = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
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
    return yield* handler.pipe(
      Effect.provideService(McpRoomInvocation, scope),
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
    // The user's default for new threads: the last reasoning an agent-made thread follows.
    const userDefaultModel = settings.getSettings.pipe(
      Effect.map((current) => current.newThreadModelSelection),
      Effect.orElseSucceed(() => null),
    );
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
      userDefaultModel,
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
      userDefaultModel,
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
    return {
      room_agents: () => Effect.flatMap(caller, handlers.room_agents),
      room_history: (input) =>
        Effect.flatMap(caller, (scope) => handlers.room_history(scope, input)),
      room_diff: (input) => Effect.flatMap(caller, (scope) => handlers.room_diff(scope, input)),
      room_ask: (input) => Effect.flatMap(caller, (scope) => handlers.room_ask(scope, input)),
      room_review: (input) => Effect.flatMap(caller, (scope) => handlers.room_review(scope, input)),
      room_hand_off: (input) =>
        Effect.flatMap(caller, (scope) => handlers.room_hand_off(scope, input)),
      room_available_agents: () => Effect.flatMap(caller, handlers.room_available_agents),
      room_invite: (input) => Effect.flatMap(caller, (scope) => handlers.room_invite(scope, input)),
      thread_agents: (input) =>
        Effect.flatMap(caller, (scope) => threadHandlers.thread_agents(scope, input)),
      thread_start: (input) =>
        Effect.flatMap(caller, (scope) => threadHandlers.thread_start(scope, input)),
      thread_list: (input) =>
        Effect.flatMap(caller, (scope) => threadHandlers.thread_list(scope, input)),
      thread_read: (input) =>
        Effect.flatMap(caller, (scope) => threadHandlers.thread_read(scope, input)),
      thread_send: (input) =>
        Effect.flatMap(caller, (scope) => threadHandlers.thread_send(scope, input)),
      thread_stop: (input) =>
        Effect.flatMap(caller, (scope) => threadHandlers.thread_stop(scope, input)),
      schedule_list: (input) =>
        Effect.flatMap(caller, (scope) => scheduleHandlers.schedule_list(scope, input)),
      schedule_create: (input) =>
        Effect.flatMap(caller, (scope) => scheduleHandlers.schedule_create(scope, input)),
      schedule_update: (input) =>
        Effect.flatMap(caller, (scope) => scheduleHandlers.schedule_update(scope, input)),
      scheduled_run_finish: (input) =>
        Effect.flatMap(caller, (scope) => scheduleHandlers.scheduled_run_finish(scope, input)),
      // Listed only to runtimes granted it; a call from any other is refused
      // too (a review runtime reads the checkout and nothing else).
      app_guide: (input) =>
        Effect.flatMap(caller, (scope) =>
          scope.roomTools.has(GUIDE_TOOL_NAME)
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
