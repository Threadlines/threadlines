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
import { PullRequestObservations } from "../pullRequest/PullRequestObservations.ts";
import {
  agentInvitesMode,
  agentThreadsMode,
  agentThreadsShareWorktrees,
} from "@threadlines/shared/serverSettings";
import type { ModelSelection, ThreadId } from "@threadlines/contracts";
import { runtimeModeOnAgent } from "@threadlines/shared/runtimeMode";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ALERT_ASSISTANTS_TOOL_NAME,
  GUIDE_TOOL_NAME,
  INVITE_TOOL_NAMES,
  MULTI_AGENT_ROOM_TOOL_NAMES,
  PROJECT_NOTE_READ_TOOL_NAME,
  PROJECT_NOTE_WRITE_TOOL_NAME,
  SCHEDULE_TOOL_NAMES,
  SCHEDULED_RUN_TOOL_NAME,
  SECRET_REQUEST_TOOL_NAME,
  SETTINGS_CHANGE_TOOL_NAME,
  THREAD_TOOL_NAMES,
} from "./roomToolAccess.ts";
import { hasAgentRecords } from "@threadlines/shared/threadParticipants";
import { ProjectContext } from "../projectContext/ProjectContext.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { ComputerLinkClient } from "../links/ComputerLinkClient.ts";
import { ComputerLinks } from "../links/ComputerLinks.ts";
import { OutsideAgentSignIn } from "../outsideAgents/OutsideAgentSignIn.ts";
import { ComputerLinkRepository } from "../links/ComputerLinkRepository.ts";
import { makeThreadToolLinks } from "../links/threadToolLinks.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { ScheduledTasks } from "../scheduled/ScheduledTasks.ts";
import { MoveQueue } from "../moves/MoveQueue.ts";

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
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import { McpRoomInvocation, RoomToolkit } from "./roomTools.ts";
import { makeGuideToolHandler } from "./guideToolHandlers.ts";
import { GuideToolkit } from "./guideTools.ts";
import { offeredModels } from "../settingsChanges/modelChoices.ts";
import { makeSettingsChangeToolHandler } from "./settingsChangeToolHandlers.ts";
import { ThemeLibrary } from "../themes/ThemeLibrary.ts";
import { SettingsChangeToolkit } from "./settingsChangeTools.ts";
import { makeSecretRequestToolHandler } from "./secretRequestToolHandlers.ts";
import { SecretRequestToolkit } from "./secretRequestTools.ts";
import { AgentSecretRequests } from "../secrets/AgentSecretRequests.ts";
import { SecretScrubber } from "../secrets/SecretScrubber.ts";
import { makeAlertAssistantsToolHandler } from "./alertAssistantsToolHandlers.ts";
import { AlertAssistantsToolkit } from "./alertAssistantsTools.ts";
import { makeProjectNoteToolHandlers } from "./projectNoteToolHandlers.ts";
import { ProjectNoteToolkit } from "./projectNoteTools.ts";
import { AssistantAlerts } from "../assistants/AssistantAlerts.ts";
import { makeScheduleToolHandlers } from "./scheduleToolHandlers.ts";
import { ScheduleToolkit } from "./scheduleTools.ts";
import { makeThreadToolHandlers } from "./threadToolHandlers.ts";
import { ThreadToolkit } from "./threadTools.ts";
import { requestService } from "./requestService.ts";

/** Every tool the endpoint serves. */
export const RoomEndpointToolkit = Toolkit.merge(
  RoomToolkit,
  ThreadToolkit,
  ScheduleToolkit,
  GuideToolkit,
  SettingsChangeToolkit,
  SecretRequestToolkit,
  AlertAssistantsToolkit,
  ProjectNoteToolkit,
);

type RoomEndpointToolName = keyof typeof RoomEndpointToolkit.tools;

/** Why a call that changes something was refused: it held a saved key's value. */
export const secretInCallDetail = (name: string) =>
  `Your call contains ${name}. Don't pass a key through this tool. The other agent can ask the user for it.`;

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
  // Files away threads the caller started, from the user's active list.
  thread_wrap: "changes",
  // Moves only the caller's own thread, but off this computer.
  thread_move: "changes",
  schedule_list: "project",
  schedule_create: "changes",
  schedule_update: "changes",
  // Records that the caller's own scheduled run is done: its own thread only.
  scheduled_run_finish: "own",
  // Only shows a card on the caller's own thread, but asks to change app-wide
  // settings: refused while outside work limits the caller.
  settings_change: "changes",
  // Only shows a card on the caller's own thread, and the key lands in its
  // own folder or its own private file.
  secret_request: "own",
  // Only marks the caller's own turn, but sends word of it off this computer:
  // refused while outside work limits the caller.
  alert_assistants: "changes",
  // Reads the caller's project's notes: beyond its own thread.
  project_note_read: "project",
  // Leaves a note other threads may read: refused while outside work limits
  // the caller (docs/design/project-brief-notes.md, "What a write becomes").
  project_note_write: "changes",
} as const satisfies Record<
  Exclude<RoomEndpointToolName, typeof GUIDE_TOOL_NAME>,
  "own" | "project" | "changes"
>;
type ToolsReaching<R> = {
  [K in keyof typeof ROOM_TOOL_REACH]: (typeof ROOM_TOOL_REACH)[K] extends R ? K : never;
}[keyof typeof ROOM_TOOL_REACH];

const jsonDecoder = new TextDecoder();
const jsonEncoder = new TextEncoder();

/** One-line MCP initialize instructions tailored to the tools this session may call. */
export function roomInstructionsFor(listed: ReadonlySet<string>): string {
  const groups: Array<string> = [];
  if (listed.has(GUIDE_TOOL_NAME)) groups.push("app guide");
  if (listed.has(SETTINGS_CHANGE_TOOL_NAME)) groups.push("settings changes");
  if (listed.has(SECRET_REQUEST_TOOL_NAME)) groups.push("secret requests");
  if (listed.has(ALERT_ASSISTANTS_TOOL_NAME)) groups.push("assistant alerts");
  if (listed.has(PROJECT_NOTE_READ_TOOL_NAME) || listed.has(PROJECT_NOTE_WRITE_TOOL_NAME)) {
    groups.push("project notes");
  }
  if (SCHEDULE_TOOL_NAMES.some((tool) => listed.has(tool)) || listed.has(SCHEDULED_RUN_TOOL_NAME)) {
    groups.push("scheduled tasks");
  }
  if (THREAD_TOOL_NAMES.some((tool) => listed.has(tool))) groups.push("child threads");
  if (INVITE_TOOL_NAMES.some((tool) => listed.has(tool))) groups.push("agent invites");
  if (listed.has("room_ask") || listed.has("room_review") || listed.has("room_hand_off")) {
    groups.push("room coordination");
  } else {
    if (listed.has("room_history")) groups.push("room history");
    if (listed.has("room_diff")) groups.push("checkout git diff");
  }
  if (groups.length === 0) return ROOM_MCP_SERVER_INSTRUCTIONS;
  return `Threadlines workspace tools for this session: ${groups.join(", ")}.`;
}

/** Tailors `initialize` `result.instructions` to the credential's granted tools. */
function tailorInitializeInstructions(
  response: HttpServerResponse.HttpServerResponse,
  instructions: string,
): HttpServerResponse.HttpServerResponse {
  const body = response.body;
  if (body._tag !== "Uint8Array" || !body.contentType.includes("json")) return response;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonDecoder.decode(body.body));
  } catch {
    return response;
  }
  let changed = false;
  const rewrite = (message: unknown): unknown => {
    if (typeof message !== "object" || message === null || !("result" in message)) return message;
    const result = message.result;
    if (
      typeof result !== "object" ||
      result === null ||
      !("protocolVersion" in result) ||
      !("serverInfo" in result)
    ) {
      return message;
    }
    changed = true;
    return { ...message, result: { ...result, instructions } };
  };
  const updated = Array.isArray(parsed) ? parsed.map(rewrite) : rewrite(parsed);
  if (!changed) return response;
  return HttpServerResponse.setBody(
    response,
    HttpBody.uint8Array(jsonEncoder.encode(JSON.stringify(updated)), body.contentType),
  );
}

const authenticate = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const snapshots = yield* Effect.serviceOption(ProjectionSnapshotQuery);
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
    // Live settings hide tools whose feature is off so agents do not carry
    // unusable schemas on every turn (their handlers refuse calls too).
    const currentSettings = yield* settings.getSettings.pipe(Effect.option);
    const threadsOff = Option.match(currentSettings, {
      onNone: () => true,
      onSome: (current) => agentThreadsMode(current) === "off",
    });
    const invitesOff = Option.match(currentSettings, {
      onNone: () => true,
      onSome: (current) => agentInvitesMode(current) === "off",
    });
    const notesOff = Option.match(currentSettings, {
      onNone: () => true,
      onSome: (current) => current.projectNotes === "off",
    });
    // Solo threads do not list multi-agent room tools; entering a room restarts
    // the runtime so it picks them up. Side runtimes keep their narrow grants.
    const soloThread =
      scope.side === undefined && Option.isSome(snapshots)
        ? yield* snapshots.value.getThreadShellById(scope.threadId).pipe(
            Effect.map((shell) => Option.isSome(shell) && !hasAgentRecords(shell.value)),
            Effect.orElseSucceed(() => false),
          )
        : false;
    if (scope.side === undefined) {
      yield* mcpSessionRegistry.recordListedRoomScope(scope.sessionKey, scope.generation, {
        inRoom: !soloThread,
        invitesOn: !invitesOff,
        threadsOn: !threadsOff,
      });
    }
    const listed: ReadonlySet<string> = new Set(
      [...scope.roomTools].filter(
        (tool) =>
          !(soloThread && (MULTI_AGENT_ROOM_TOOL_NAMES as ReadonlyArray<string>).includes(tool)) &&
          !(invitesOff && (INVITE_TOOL_NAMES as ReadonlyArray<string>).includes(tool)) &&
          !(
            threadsOff &&
            ((SCHEDULE_TOOL_NAMES as ReadonlyArray<string>).includes(tool) ||
              (THREAD_TOOL_NAMES as ReadonlyArray<string>).includes(tool))
          ) &&
          !(notesOff && tool === PROJECT_NOTE_WRITE_TOOL_NAME),
      ),
    );
    // Read per call: outside work can limit a credential while it lives.
    const outsideLimit = yield* limits.forScope(scope);
    return yield* handler.pipe(
      Effect.provideService(
        McpRoomInvocation,
        outsideLimit === null ? scope : { ...scope, outsideLimit },
      ),
      Effect.map((response) =>
        tailorInitializeInstructions(
          listOnlyGrantedTools(normalizeMcpHttpResponse(response), listed),
          roomInstructionsFor(listed),
        ),
      ),
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
    const secretScrubber = yield* SecretScrubber;
    // Linked computers, when this server has them (docs/design/fleet.md).
    const linkClient = yield* Effect.serviceOption(ComputerLinkClient);
    const linkRepo = yield* Effect.serviceOption(ComputerLinkRepository);
    const identities = yield* Effect.serviceOption(RepositoryIdentityResolver);
    const pullRequestObservations = yield* Effect.serviceOption(PullRequestObservations);
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
    const modelNameOf = (selection: ModelSelection) =>
      providers.getProviders.pipe(
        Effect.map((all) => {
          const model = all
            .find((provider) => provider.instanceId === selection.instanceId)
            ?.models.find((candidate) => candidate.slug === selection.model);
          return model?.shortName ?? model?.name ?? selection.model;
        }),
      );
    const analytics = yield* Effect.serviceOption(AnalyticsService);
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
      modelNameOf,
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
      ...(Option.isSome(analytics) ? { recordAnalytics: analytics.value.record } : {}),
    });
    // Scheduled tasks, when this server has them (docs/design/fleet.md, Part 6).
    const scheduledTasks = yield* Effect.serviceOption(ScheduledTasks);
    // Moving a thread to a linked computer, when this server has links (Part 3b).
    const moveQueue = yield* Effect.serviceOption(MoveQueue);
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
      ...(Option.isSome(pullRequestObservations)
        ? { knownPullRequests: pullRequestObservations.value.known }
        : {}),
      providers: providers.getProviders,
      userDefaultModel,
      threadsMode: settings.getSettings.pipe(
        Effect.map(agentThreadsMode),
        Effect.orElseSucceed(() => "off" as const),
      ),
      shareWorktrees: settings.getSettings.pipe(
        Effect.map(agentThreadsShareWorktrees),
        Effect.orElseSucceed(() => false),
      ),
      git,
      requests,
      ...(links !== undefined ? { links } : {}),
      ...(Option.isSome(scheduledTasks)
        ? { scheduleAnswerWaiting: scheduledTasks.value.waitingThreadIds }
        : {}),
      ...(Option.isSome(moveQueue) ? { moves: { queue: moveQueue.value.queue } } : {}),
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
      modelChoices: providers.getProviders.pipe(Effect.map(offeredModels)),
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
    const themeLibrary = yield* Effect.serviceOption(ThemeLibrary);
    const settingsChange = makeSettingsChangeToolHandler({
      engine,
      readThread,
      settings: settings.readStored.pipe(Effect.orElseSucceed(() => undefined)),
      providers: providers.getProviders,
      themeNames: Option.isSome(themeLibrary)
        ? themeLibrary.value.snapshot.pipe(
            Effect.map(({ entries }) =>
              entries.filter((entry) => !entry.deleted).map((entry) => entry.name),
            ),
            Effect.orElseSucceed(() => []),
          )
        : Effect.succeed([]),
    });
    const secretRequests = yield* AgentSecretRequests;
    const secretRequest = makeSecretRequestToolHandler({
      engine,
      readThread,
      threadFolder: secretRequests.threadFolder,
      destinations: secretRequests.destinations,
    });
    const assistantAlerts = yield* Effect.serviceOption(AssistantAlerts);
    const alertAssistants = makeAlertAssistantsToolHandler({
      readThread,
      isGeneralChat: (projectId) =>
        snapshots.getProjectShellById(projectId).pipe(
          Effect.map((project) => Option.getOrUndefined(project)?.kind === "general-chat"),
          // Not knowing isn't knowing it is: the sender drops General Chats anyway.
          Effect.orElseSucceed(() => false),
        ),
      alerts: Option.getOrUndefined(assistantAlerts),
    });
    const projectContext = yield* Effect.serviceOption(ProjectContext);
    const projectNotes = makeProjectNoteToolHandlers({
      readThread,
      context: Option.getOrUndefined(projectContext),
      notesMode: settings.getSettings.pipe(
        Effect.map((current) => current.projectNotes),
        Effect.orElseSucceed(() => "off" as const),
      ),
      // The level the runtime's chat asks for, and the one it really runs
      // at: an agent without the asked level (Pi has no Auto) runs at the
      // next safer one. A provider that can't be found reads as the three
      // legacy levels, which only lowers `runs`.
      runtimeModeOf: (sessionKey) =>
        Effect.gen(function* () {
          const session = (yield* providerService.listSessions()).find(
            (entry) => entry.threadId === sessionKey,
          );
          if (session === undefined) return undefined;
          const provider = (yield* providers.getProviders).find(
            (entry) => entry.instanceId === session.providerInstanceId,
          );
          return {
            asked: session.runtimeMode,
            runs: runtimeModeOnAgent({
              requested: session.runtimeMode,
              providerModes: provider?.supportedRuntimeModes,
              modelModes: provider?.models.find((model) => model.slug === session.model)
                ?.supportedRuntimeModes,
            }),
          };
        }).pipe(Effect.orElseSucceed(() => undefined)),
      modelNameOf: (selection) =>
        modelNameOf(selection).pipe(Effect.orElseSucceed(() => selection.model)),
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
    /**
     * Refuses a call whose input holds a saved key's value: what these tools
     * carry reaches another agent, a thread, a card or a task's history, none
     * of which hides one (docs/design/secret-scrubbing.md).
     */
    const unlessWatched = <A, R = Refused>(
      input: unknown,
      run: () => Effect.Effect<A>,
      refusedAs: (detail: string) => R = (detail) =>
        ({ outcome: "refused", detail }) satisfies Refused as R,
    ): Effect.Effect<A | R> => {
      const [watched] = secretScrubber.contains(input);
      return watched === undefined ? run() : Effect.succeed(refusedAs(secretInCallDetail(watched)));
    };
    const changes = <A>(
      _tool: ToolsReaching<"changes">,
      input: unknown,
      run: (scope: McpInvocationScope) => Effect.Effect<A>,
    ) =>
      Effect.flatMap(caller, (scope): Effect.Effect<A | Refused> => {
        if (scope.outsideLimit !== undefined) {
          return Effect.succeed({
            outcome: "refused",
            detail: outsideLimitDetail(scope.outsideLimit),
          });
        }
        return unlessWatched(input, () => run(scope));
      });
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
      room_ask: (input) => changes("room_ask", input, (scope) => handlers.room_ask(scope, input)),
      room_review: (input) =>
        changes("room_review", input, (scope) => handlers.room_review(scope, input)),
      room_hand_off: (input) =>
        changes("room_hand_off", input, (scope) => handlers.room_hand_off(scope, input)),
      room_available_agents: () => own("room_available_agents", handlers.room_available_agents),
      room_invite: (input) =>
        changes("room_invite", input, (scope) => handlers.room_invite(scope, input)),
      thread_agents: (input) =>
        projectRead(
          "thread_agents",
          (scope) => threadHandlers.thread_agents(scope, input),
          (detail) => ({ outcome: "refused", detail, agents: [], unavailable: [] }),
        ),
      thread_start: (input) =>
        changes("thread_start", input, (scope) => threadHandlers.thread_start(scope, input)),
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
        changes("thread_send", input, (scope) => threadHandlers.thread_send(scope, input)),
      thread_stop: (input) =>
        changes("thread_stop", input, (scope) => threadHandlers.thread_stop(scope, input)),
      thread_wrap: (input) =>
        changes("thread_wrap", input, (scope) => threadHandlers.thread_wrap(scope, input)),
      thread_move: (input) =>
        changes("thread_move", input, (scope) => threadHandlers.thread_move(scope, input)),
      schedule_list: (input) =>
        projectRead(
          "schedule_list",
          (scope) => scheduleHandlers.schedule_list(scope, input),
          (detail) => ({ outcome: "refused", detail, tasks: [] }),
        ),
      schedule_create: (input) =>
        changes("schedule_create", input, (scope) =>
          scheduleHandlers.schedule_create(scope, input),
        ),
      schedule_update: (input) =>
        changes("schedule_update", input, (scope) =>
          scheduleHandlers.schedule_update(scope, input),
        ),
      scheduled_run_finish: (input) =>
        own("scheduled_run_finish", (scope) =>
          unlessWatched(
            input,
            () => scheduleHandlers.scheduled_run_finish(scope, input),
            (detail) => ({ outcome: "not_allowed" as const, detail }),
          ),
        ),
      settings_change: (input) =>
        changes("settings_change", input, (scope) => settingsChange(scope, input)),
      secret_request: (input) =>
        own("secret_request", (scope) => unlessWatched(input, () => secretRequest(scope, input))),
      alert_assistants: () => changes("alert_assistants", undefined, alertAssistants),
      project_note_read: (input) =>
        projectRead(
          "project_note_read",
          (scope) => projectNotes.project_note_read(scope, input),
          (detail) => ({ outcome: "refused", detail }),
        ),
      project_note_write: (input) =>
        changes("project_note_write", input, (scope) =>
          projectNotes.project_note_write(scope, input),
        ),
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

export const ROOM_MCP_SERVER_INSTRUCTIONS =
  "Threadlines workspace tools available to this session.";

/**
 * The room endpoint with the given tool handlers: production's below; the
 * tool-use evals (apps/server/evals) serve the same tools, listing and
 * sign-in check with canned answers.
 */
export const makeLayer = <E, R>(
  handlers: Layer.Layer<Tool.HandlersFor<typeof RoomEndpointToolkit.tools>, E, R>,
) =>
  Layer.fresh(
    McpServer.toolkit(RoomEndpointToolkit).pipe(
      Layer.provide(handlers),
      Layer.provideMerge(
        McpServer.layerHttp({
          name: "threadlines-room",
          version: "1",
          path: MCP_ROOM_ROUTE_PATH,
          instructions: ROOM_MCP_SERVER_INSTRUCTIONS,
          protocols: [McpProtocol.v2025_06_18],
        }).pipe(Layer.provide(AuthenticationLive)),
      ),
    ),
  );

export const layer = makeLayer(RoomToolHandlersLive);
