// @effect-diagnostics nodeBuiltinImport:off
import NodePath from "node:path";

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  type AuthAccessStreamEvent,
  AuthSessionId,
  CommandId,
  type OrchestrationCommand,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetRevertPlanError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnActivitiesError,
  OrchestrationGetTurnDiffError,
  OrchestrationThreadSearchError,
  ORCHESTRATION_WS_METHODS,
  ChatAttachmentReadError,
  CodexInlineVisualizationReadError,
  CodexSettings,
  ProviderDriverKind,
  ProjectFaviconError,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  OrchestrationReplayEventsError,
  FilesystemBrowseError,
  type ProviderAuthEvent,
  ProviderExtensionsError,
  ProviderExternalThreadError,
  type ProviderInstanceId,
  ProviderRealtimeError,
  ProviderSubagentInputError,
  ProviderSubagentTranscriptError,
  ThreadId,
  type TerminalEvent,
  SourceControlToolUpdateError,
  WS_METHODS,
  WsRpcGroup,
  WsOwnerRequiredError,
} from "@threadlines/contracts";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { resolveAttachmentPathById } from "./attachmentStore.ts";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery.ts";
import { CheckpointRevert } from "./checkpointing/Services/CheckpointRevert.ts";
import { ServerConfig } from "./config.ts";
import { fileAttachmentMimeTypeForExtension } from "@threadlines/shared/fileAttachments";
import { IMAGE_MIME_TYPE_BY_EXTENSION } from "./imageMime.ts";
import { Keybindings } from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import { normalizeDispatchCommand } from "./orchestration/Normalizer.ts";
import { coalesceLatestAggregateEvents } from "./orchestration/shellStreamCoalescing.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBootstrap } from "./orchestration/Services/ThreadBootstrap.ts";
import { ThreadSearch } from "./orchestration/Services/ThreadSearch.ts";
import { UsageService } from "./usage/UsageService.ts";
import {
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import { PreviewAutomationBroker } from "./preview/PreviewAutomationBroker.ts";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver.ts";
import { PullRequestService } from "./pullRequest/PullRequestService.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";
import { ProviderService } from "./provider/Services/ProviderService.ts";
import { readCodexInlineVisualization } from "./provider/CodexInlineVisualization.ts";
import { resolveCodexHomeLayout } from "./provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "./provider/Layers/ProviderInstanceRegistryHydration.ts";
import { startProviderReviewForThread } from "./provider/ProviderReviewCoordinator.ts";
import { importExternalProviderThread } from "./provider/ExternalThreadImport.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import {
  addProviderExtensionMarketplace,
  callProviderExtensionMcpTool,
  createProviderExtensionSkill,
  deleteProviderExtensionSkill,
  getProviderExtensionOperationStatus,
  installProviderExtensionPlugin,
  readProviderInstructionFiles,
  readProviderExtensionsInventory,
  readProviderExtensionMcpResource,
  readProviderExtensionPlugin,
  readProviderExtensionSkill,
  refreshProviderExtensionPluginMarketplaces,
  removeProviderExtensionMarketplace,
  reloadProviderExtensionMcpServers,
  setProviderExtensionPluginEnabled,
  setProviderExtensionSkillEnabled,
  startProviderExtensionMcpOAuth,
  uninstallProviderExtensionPlugin,
  updateProviderExtensionPlugin,
  writeInstructionFile,
} from "./provider/providerExtensions.ts";
import { ServerLifecycleEvents } from "./serverLifecycleEvents.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";
import { redactServerSettingsForClient, ServerSettingsService } from "./serverSettings.ts";
import { ProviderAuthSessions } from "./provider/auth/ProviderAuthSessions.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { realtimeAudioHub } from "./realtime/RealtimeAudioHub.ts";
import { DictationService } from "./dictation/DictationService.ts";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem.ts";
import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths.ts";
import { VcsStatusBroadcaster } from "./vcs/VcsStatusBroadcaster.ts";
import { ensureWorktreeRemovable } from "./vcs/WorktreeRemovalGuard.ts";
import { VcsProvisioningService } from "./vcs/VcsProvisioningService.ts";
import { GitAuthRemediationService } from "./git/GitAuthRemediationService.ts";
import { GitWorkflowService } from "./git/GitWorkflowService.ts";
import { RepositoryIdentityResolver } from "./project/Services/RepositoryIdentityResolver.ts";
import { RelayHost } from "./relay/RelayHost.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import { ServerAuth } from "./auth/Services/ServerAuth.ts";
import { makeBackgroundRunOutputReader } from "./diagnostics/BackgroundRunOutput.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as SourceControlDiscoveryLayer from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlToolMaintenance from "./sourceControl/SourceControlToolMaintenance.ts";
import * as GitHubAuth from "./sourceControl/GitHubAuth.ts";
import { refreshWindowsPath } from "@threadlines/shared/shell";
import { sessionKeyThreadId } from "@threadlines/shared/threadParticipants";
import { SourceControlRepositoryService } from "./sourceControl/SourceControlRepositoryService.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import {
  BootstrapCredentialService,
  type BootstrapCredentialChange,
} from "./auth/Services/BootstrapCredentialService.ts";
import {
  SessionCredentialService,
  type SessionCredentialChange,
} from "./auth/Services/SessionCredentialService.ts";
import { respondToAuthError } from "./auth/http.ts";
import { isInternalClientSession } from "./auth/utils.ts";

const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isWorkspacePathOutsideRootError = Schema.is(WorkspacePathOutsideRootError);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.follow-up-submitted"
      | "thread.follow-up-accepted"
      | "thread.follow-up-queued"
      | "thread.follow-up-unqueued"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.turn-diff-summary-updated"
      | "thread.reverted"
      | "thread.session-set"
      | "thread.realtime-start-requested"
      | "thread.realtime-stop-requested"
      | "thread.realtime-state-set"
      | "thread.agent-request-submitted"
      | "thread.agent-request-updated"
      | "thread.agent-request-settled"
      | "thread.agent-requests-held"
      | "thread.agent-requests-reset"
      | "thread.child-request-submitted"
      | "thread.child-request-updated"
      | "thread.child-request-settled"
      | "thread.child-notes-delivered"
      | "thread.child-deliveries-cancelled"
      | "thread.child-requests-reset"
      | "thread.handed-back"
      | "thread.parent-attachment-set";
  }
> {
  return (
    // Agent requests live only on the thread's detail, never on its shell,
    // so their events have to come this way for an open thread to see them.
    event.type === "thread.agent-request-submitted" ||
    event.type === "thread.agent-request-updated" ||
    event.type === "thread.agent-request-settled" ||
    event.type === "thread.agent-requests-held" ||
    event.type === "thread.agent-requests-reset" ||
    // Likewise a parent's child requests and notes (child threads), and a
    // child's lineage changes, which an open chat shows as they happen.
    event.type === "thread.child-request-submitted" ||
    event.type === "thread.child-request-updated" ||
    event.type === "thread.child-request-settled" ||
    event.type === "thread.child-notes-delivered" ||
    event.type === "thread.child-deliveries-cancelled" ||
    event.type === "thread.child-requests-reset" ||
    event.type === "thread.handed-back" ||
    event.type === "thread.parent-attachment-set" ||
    event.type === "thread.message-sent" ||
    event.type === "thread.follow-up-submitted" ||
    event.type === "thread.follow-up-accepted" ||
    event.type === "thread.follow-up-queued" ||
    event.type === "thread.follow-up-unqueued" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.turn-diff-summary-updated" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set" ||
    event.type === "thread.realtime-start-requested" ||
    event.type === "thread.realtime-stop-requested" ||
    event.type === "thread.realtime-state-set"
  );
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;
export const ORCHESTRATION_THREAD_RESUME_MAX_SEQUENCE_GAP = 500;

function toAuthAccessStreamEvent(
  change: BootstrapCredentialChange | SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const makeWsRpcLayer = (currentSession: {
  readonly sessionId: AuthSessionId;
  readonly role: "owner" | "client";
}) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const currentSessionId = currentSession.sessionId;
      // Access management is owner-only. Everything else stays open to client
      // sessions: a paired device is meant to use projects, turns, terminals.
      const requireOwner = (method: string) =>
        currentSession.role === "owner"
          ? Effect.void
          : Effect.fail(new WsOwnerRequiredError({ method }));
      const relayHost = yield* RelayHost;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const threadSearch = yield* ThreadSearch;
      const usage = yield* UsageService;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const threadBootstrap = yield* ThreadBootstrap;
      const checkpointDiffQuery = yield* CheckpointDiffQuery;
      const checkpointRevert = yield* CheckpointRevert;
      const keybindings = yield* Keybindings;
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
      const gitWorkflow = yield* GitWorkflowService;
      const gitAuthRemediation = yield* GitAuthRemediationService;
      const pullRequests = yield* PullRequestService;
      const vcsProvisioning = yield* VcsProvisioningService;
      const previewAutomationBroker = yield* PreviewAutomationBroker;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager;
      const providerAuthSessions = yield* ProviderAuthSessions;
      const dictation = yield* DictationService;
      const providerRegistry = yield* ProviderRegistry;
      const providerService = yield* ProviderService;
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const lifecycleEvents = yield* ServerLifecycleEvents;
      const serverSettings = yield* ServerSettingsService;
      const startup = yield* ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem;
      const projectFaviconResolver = yield* ProjectFaviconResolver;
      const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
      const serverEnvironment = yield* ServerEnvironment;
      const serverAuth = yield* ServerAuth;
      const sourceControlDiscovery = yield* SourceControlDiscoveryLayer.SourceControlDiscovery;
      const sourceControlToolMaintenance =
        yield* SourceControlToolMaintenance.SourceControlToolMaintenance;
      const githubAuth = yield* GitHubAuth.GitHubAuth;
      const automaticGitFetchInterval = serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.automaticGitFetchInterval),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read automatic Git fetch interval setting", {
            detail: cause.message,
          }).pipe(Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
        ),
      );
      const sourceControlRepositories = yield* SourceControlRepositoryService;
      const bootstrapCredentials = yield* BootstrapCredentialService;
      const sessions = yield* SessionCredentialService;
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      const readBackgroundRunOutput = makeBackgroundRunOutputReader(projectionSnapshotQuery);
      const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;

      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks().pipe(Effect.orDie),
          clientSessions: serverAuth.listClientSessions(currentSessionId).pipe(Effect.orDie),
        });

      const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
        isOrchestrationDispatchCommandError(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: cause instanceof Error ? cause.message : fallbackMessage,
              cause,
            });

      const enrichProjectEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<OrchestrationEvent, never, never> => {
        switch (event.type) {
          case "project.created":
            return repositoryIdentityResolver.resolve(event.payload.workspaceRoot).pipe(
              Effect.map((repositoryIdentity) => ({
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              })),
            );
          case "project.meta-updated":
            return Effect.gen(function* () {
              const workspaceRoot =
                event.payload.workspaceRoot ??
                Option.match(
                  yield* projectionSnapshotQuery.getProjectShellById(event.payload.projectId),
                  {
                    onNone: () => null,
                    onSome: (project) => project.workspaceRoot,
                  },
                ) ??
                null;
              if (workspaceRoot === null) {
                return event;
              }

              const repositoryIdentity = yield* repositoryIdentityResolver.resolve(workspaceRoot);
              return {
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              } satisfies OrchestrationEvent;
            }).pipe(Effect.catch(() => Effect.succeed(event)));
          default:
            return Effect.succeed(event);
        }
      };

      const enrichOrchestrationEvents = (events: ReadonlyArray<OrchestrationEvent>) =>
        Effect.forEach(events, enrichProjectEvent, { concurrency: 4 });

      const toShellStreamEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
            return projectionSnapshotQuery.getProjectShellById(event.payload.projectId).pipe(
              Effect.map((project) =>
                Option.map(project, (nextProject) => ({
                  kind: "project-upserted" as const,
                  sequence: event.sequence,
                  project: nextProject,
                })),
              ),
              Effect.catch(() => Effect.succeed(Option.none())),
            );
          case "project.deleted":
            return Effect.succeed(
              Option.some({
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: event.payload.projectId,
              }),
            );
          case "thread.deleted":
          case "thread.archived":
            return Effect.succeed(
              Option.some({
                kind: "thread-removed" as const,
                sequence: event.sequence,
                threadId: event.payload.threadId,
              }),
            );
          case "thread.unarchived":
            return projectionSnapshotQuery.getThreadShellById(event.payload.threadId).pipe(
              Effect.map((thread) =>
                Option.map(thread, (nextThread) => ({
                  kind: "thread-upserted" as const,
                  sequence: event.sequence,
                  thread: nextThread,
                })),
              ),
              Effect.catch(() => Effect.succeed(Option.none())),
            );
          default:
            if (event.aggregateKind !== "thread") {
              return Effect.succeed(Option.none());
            }
            return projectionSnapshotQuery
              .getThreadShellById(ThreadId.make(event.aggregateId))
              .pipe(
                Effect.map((thread) =>
                  Option.map(thread, (nextThread) => ({
                    kind: "thread-upserted" as const,
                    sequence: event.sequence,
                    thread: nextThread,
                  })),
                ),
                Effect.catch(() => Effect.succeed(Option.none())),
              );
        }
      };

      // A first send that also creates the thread, cuts its worktree and
      // launches its setup script (see ThreadBootstrap.runTurnStart).
      const dispatchBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        threadBootstrap.runTurnStart(command);

      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
        const dispatchEffect =
          normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
            ? dispatchBootstrapTurnStart(normalizedCommand)
            : orchestrationEngine
                .dispatch(normalizedCommand)
                .pipe(
                  Effect.mapError((cause) =>
                    toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                  ),
                );

        return startup
          .enqueueCommand(dispatchEffect)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
      };

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providers = yield* providerRegistry.getProviders;
        const settings = redactServerSettingsForClient(yield* serverSettings.getSettings);
        const environment = yield* serverEnvironment.getDescriptor;
        const auth = yield* serverAuth.getDescriptor();

        return {
          environment,
          auth,
          cwd: config.cwd,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors: ExternalLauncher.resolveAvailableEditors(),
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? { otlpMetricsUrl: config.otlpMetricsUrl }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          },
          settings,
        };
      });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      /**
       * Child threads: archiving a parent archives its settled children in
       * the same command (the decider decides which). Each of them gets the
       * cleanup the named thread gets: its live runtimes stopped, its
       * terminals closed. Found in the events this command wrote; a retried
       * command that wrote none finds none.
       */
      const cleanUpArchivedWith = (input: {
        readonly commandId: CommandId;
        readonly threadId: ThreadId;
        readonly fromSequenceExclusive: number;
        readonly throughSequence: number;
      }) =>
        Effect.gen(function* () {
          const archived = yield* orchestrationEngine.readEvents(input.fromSequenceExclusive).pipe(
            Stream.takeWhile((event) => event.sequence <= input.throughSequence),
            Stream.filter(
              (event): event is Extract<OrchestrationEvent, { type: "thread.archived" }> =>
                event.type === "thread.archived" &&
                event.commandId === input.commandId &&
                event.payload.threadId !== input.threadId,
            ),
            Stream.map((event) => event.payload.threadId),
            Stream.runCollect,
          );
          if (archived.length === 0) {
            return;
          }
          const liveThreads = new Set(
            (yield* providerService.listSessions())
              .filter((session) => session.status !== "closed")
              .map((session) => sessionKeyThreadId(session.threadId)),
          );
          yield* Effect.forEach(
            archived,
            (threadId) =>
              Effect.gen(function* () {
                if (liveThreads.has(threadId)) {
                  yield* Effect.gen(function* () {
                    const stopCommand = yield* normalizeDispatchCommand({
                      type: "thread.session.stop",
                      commandId: CommandId.make(
                        `session-stop-for-archive:${input.commandId}:${threadId}`,
                      ),
                      threadId,
                      createdAt: yield* nowIso,
                    });
                    yield* dispatchNormalizedCommand(stopCommand);
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("failed to stop provider session during archive", {
                        threadId,
                        cause,
                      }),
                    ),
                  );
                }
                yield* terminalManager.close({ threadId }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to close thread terminals after archive", {
                      threadId,
                      error: error.message,
                    }),
                  ),
                );
              }),
            { discard: true },
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to clean up threads archived with their parent", {
              threadId: input.threadId,
              cause,
            }),
          ),
        );

      const loadProviderExtensionSettings = serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderExtensionsError({
              message: cause.message,
              cause,
            }),
        ),
      );
      // Settings changed a provider's plugins or skills. Its open sessions pick that up before
      // their next turn (see ProviderAdapter.noteExtensionsChanged).
      const noteExtensionsChanged = (input: { readonly providerInstanceId: ProviderInstanceId }) =>
        providerService.noteExtensionsChanged({ providerInstanceId: input.providerInstanceId });

      return WsRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              const normalizedCommand = yield* normalizeDispatchCommand(command);
              // Where the event log stood before an archive, so the threads
              // that archive took with it (a parent's settled children) can
              // be read back from what it wrote.
              const archiveCursor =
                normalizedCommand.type === "thread.archive"
                  ? yield* projectionSnapshotQuery.getSnapshotSequence().pipe(
                      Effect.map(({ snapshotSequence }) => snapshotSequence),
                      Effect.catch(() => Effect.succeed(null)),
                    )
                  : null;
              const shouldStopSessionAfterArchive =
                normalizedCommand.type === "thread.archive"
                  ? yield* projectionSnapshotQuery
                      .getThreadShellById(normalizedCommand.threadId)
                      .pipe(
                        Effect.map(
                          Option.match({
                            onNone: () => false,
                            onSome: (thread) =>
                              thread.session !== null && thread.session.status !== "stopped",
                          }),
                        ),
                        Effect.catch(() => Effect.succeed(false)),
                      )
                  : false;
              const result = yield* dispatchNormalizedCommand(normalizedCommand);
              if (normalizedCommand.type === "thread.archive") {
                if (shouldStopSessionAfterArchive) {
                  yield* Effect.gen(function* () {
                    const stopCommand = yield* normalizeDispatchCommand({
                      type: "thread.session.stop",
                      commandId: CommandId.make(
                        `session-stop-for-archive:${normalizedCommand.commandId}`,
                      ),
                      threadId: normalizedCommand.threadId,
                      createdAt: yield* nowIso,
                    });

                    yield* dispatchNormalizedCommand(stopCommand);
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("failed to stop provider session during archive", {
                        threadId: normalizedCommand.threadId,
                        cause,
                      }),
                    ),
                  );
                }

                yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to close thread terminals after archive", {
                      threadId: normalizedCommand.threadId,
                      error: error.message,
                    }),
                  ),
                );

                if (archiveCursor !== null) {
                  yield* cleanUpArchivedWith({
                    commandId: normalizedCommand.commandId,
                    threadId: normalizedCommand.threadId,
                    fromSequenceExclusive: archiveCursor,
                    throughSequence: result.sequence,
                  });
                }
              }
              return result;
            }).pipe(
              Effect.mapError((cause) =>
                isOrchestrationDispatchCommandError(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to dispatch orchestration command",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
            checkpointDiffQuery.getTurnDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnDiffError({
                    message: "Failed to load turn diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
            checkpointDiffQuery.getFullThreadDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetFullThreadDiffError({
                    message: "Failed to load full thread diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getRevertPlan]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getRevertPlan,
            checkpointRevert.getRevertPlan(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetRevertPlanError({
                    message:
                      cause._tag === "CheckpointUnavailableError"
                        ? cause.message
                        : "Failed to compute revert plan",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.searchThreads]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.searchThreads,
            threadSearch.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationThreadSearchError({
                    message: "Failed to search thread messages",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnActivities]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnActivities,
            projectionSnapshotQuery.getTurnActivities(input).pipe(
              Effect.map((activities) => ({ activities })),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnActivitiesError({
                    message: "Failed to read the turn's activity",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.replayEvents,
            Stream.runCollect(
              orchestrationEngine.readEvents(
                clamp(input.fromSequenceExclusive, {
                  maximum: Number.MAX_SAFE_INTEGER,
                  minimum: 0,
                }),
              ),
            ).pipe(
              Effect.map((events) => Array.from(events)),
              Effect.flatMap(enrichOrchestrationEvents),
              Effect.mapError(
                (cause) =>
                  new OrchestrationReplayEventsError({
                    message: "Failed to replay orchestration events",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (_input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.succeed(
              Stream.unwrap(
                Effect.gen(function* () {
                  // Subscribe to the event feed before reading the snapshot:
                  // events committed between the two are buffered by the
                  // subscription instead of lost, which would leave this
                  // subscriber stale until the next event for that aggregate.
                  const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;

                  const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
                    Effect.tapError((cause) =>
                      Effect.logError("orchestration shell snapshot load failed", { cause }),
                    ),
                    Effect.mapError(
                      (cause) =>
                        new OrchestrationGetSnapshotError({
                          message: "Failed to load orchestration shell snapshot",
                          cause,
                        }),
                    ),
                  );

                  // Coalesce the domain-event firehose before resolving shells:
                  // during streaming turns events arrive ~every 50ms per thread,
                  // and each resolved event costs projection queries plus a full
                  // thread-shell push per subscriber.
                  const liveStream = coalesceLatestAggregateEvents(
                    Stream.filter(
                      domainEvents,
                      (event) => event.sequence > snapshot.snapshotSequence,
                    ),
                  ).pipe(
                    Stream.mapEffect(toShellStreamEvent),
                    Stream.flatMap((event) =>
                      Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty,
                    ),
                  );

                  return Stream.concat(
                    Stream.make({
                      kind: "snapshot" as const,
                      snapshot,
                    }),
                    liveStream,
                  );
                }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
            projectionSnapshotQuery.getArchivedShellSnapshot().pipe(
              Effect.tapError((cause) =>
                Effect.logError("orchestration archived shell snapshot load failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load archived orchestration shell snapshot",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            Effect.succeed(
              Stream.unwrap(
                Effect.gen(function* () {
                  // Subscribe before reading, and read the sequence before the
                  // thread row: every event newer than snapshotSequence is then
                  // guaranteed to reach the live stream. An event committed
                  // between the two reads may be both in the snapshot and
                  // re-delivered, which the client's id-keyed upsert reducers
                  // absorb — losing it instead would leave the thread stale.
                  const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;

                  const snapshotSequence = yield* projectionSnapshotQuery
                    .getSnapshotSequence()
                    .pipe(
                      Effect.map(({ snapshotSequence }) => snapshotSequence),
                      Effect.mapError(
                        (cause) =>
                          new OrchestrationGetSnapshotError({
                            message: "Failed to load orchestration snapshot sequence",
                            cause,
                          }),
                      ),
                    );
                  const isThreadEvent = (event: OrchestrationEvent) =>
                    event.aggregateKind === "thread" &&
                    event.aggregateId === input.threadId &&
                    isThreadDetailEvent(event);
                  const liveStream = domainEvents.pipe(
                    Stream.filter(
                      (event) => event.sequence > snapshotSequence && isThreadEvent(event),
                    ),
                    Stream.map((event) => ({
                      kind: "event" as const,
                      event,
                    })),
                  );

                  const resumeSequence = input.fromSequenceExclusive;
                  const canResume =
                    resumeSequence !== undefined &&
                    resumeSequence <= snapshotSequence &&
                    snapshotSequence - resumeSequence <=
                      ORCHESTRATION_THREAD_RESUME_MAX_SEQUENCE_GAP;
                  if (canResume) {
                    const replayStream = orchestrationEngine.readEvents(resumeSequence).pipe(
                      // The hot subscription already buffers everything after
                      // this boundary. Keeping the persisted side bounded also
                      // prevents duplicates if commits race the replay query.
                      Stream.takeWhile((event) => event.sequence <= snapshotSequence),
                      Stream.filter(isThreadEvent),
                      Stream.map((event) => ({
                        kind: "event" as const,
                        event,
                      })),
                      Stream.mapError(
                        (cause) =>
                          new OrchestrationGetSnapshotError({
                            message: `Failed to resume thread ${input.threadId}`,
                            cause,
                          }),
                      ),
                    );
                    return Stream.concat(replayStream, liveStream);
                  }

                  const threadDetail = yield* projectionSnapshotQuery
                    .getThreadDetailById(input.threadId)
                    .pipe(
                      Effect.mapError(
                        (cause) =>
                          new OrchestrationGetSnapshotError({
                            message: `Failed to load thread ${input.threadId}`,
                            cause,
                          }),
                      ),
                    );

                  if (Option.isNone(threadDetail)) {
                    return yield* new OrchestrationGetSnapshotError({
                      message: `Thread ${input.threadId} was not found`,
                      cause: input.threadId,
                    });
                  }

                  return Stream.concat(
                    Stream.make({
                      kind: "snapshot" as const,
                      snapshot: {
                        snapshotSequence,
                        thread: threadDetail.value,
                      },
                    }),
                    liveStream,
                  );
                }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRefreshProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            Effect.sync(() => refreshWindowsPath()).pipe(
              Effect.andThen(
                input.instanceId !== undefined
                  ? providerRegistry.refreshInstance(input.instanceId)
                  : providerRegistry.refresh(),
              ),
              Effect.map((providers) => ({ providers })),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverStartProviderReview]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverStartProviderReview,
            startProviderReviewForThread(input, {
              providerService,
              projectionSnapshotQuery,
              orchestrationEngine,
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverReadSubagentTranscript]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverReadSubagentTranscript,
            providerService.readSubagentTranscript(input).pipe(
              Effect.mapError(
                (error) =>
                  new ProviderSubagentTranscriptError({
                    message:
                      error.message.trim().length > 0
                        ? error.message
                        : "Failed to read the subagent transcript.",
                  }),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverSendSubagentInput]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverSendSubagentInput,
            providerService.sendSubagentInput(input).pipe(
              Effect.mapError((error) => {
                const reason =
                  error._tag === "ProviderAdapterRequestError" &&
                  error.code === "subagent_input_parent_only"
                    ? "parentOnly"
                    : error._tag === "ProviderAdapterRequestError" &&
                        error.code === "subagent_input_invalid_target"
                      ? "invalidTarget"
                      : error._tag === "ProviderValidationError" &&
                          error.code === "subagent_input_unsupported_provider"
                        ? "unsupportedProvider"
                        : error._tag === "ProviderSessionNotFoundError" ||
                            error._tag === "ProviderAdapterSessionNotFoundError" ||
                            error._tag === "ProviderAdapterSessionClosedError"
                          ? "unavailable"
                          : "unknown";
                const message =
                  reason === "parentOnly"
                    ? "Not sent. This agent only accepts messages from its parent."
                    : reason === "unsupportedProvider"
                      ? "Not sent. This provider does not support direct agent messages."
                      : reason === "invalidTarget"
                        ? "Not sent. This agent does not belong to the current conversation."
                        : reason === "unavailable"
                          ? "Not sent. This agent is no longer available."
                          : "Not sent. Could not send this message to the agent.";
                return new ProviderSubagentInputError({ message, reason });
              }),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverListExternalProviderThreads]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverListExternalProviderThreads,
            providerService.listExternalThreads(input).pipe(
              Effect.mapError(
                (error) =>
                  new ProviderExternalThreadError({
                    message:
                      error.message.trim().length > 0
                        ? error.message
                        : "Failed to list Codex sessions.",
                    cause: error,
                  }),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverImportExternalProviderThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverImportExternalProviderThread,
            importExternalProviderThread(input, {
              providerService,
              projectionSnapshotQuery,
              orchestrationEngine,
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverConsumeProviderRateLimitResetCredit]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverConsumeProviderRateLimitResetCredit,
            providerRegistry.consumeRateLimitResetCredit(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateProvider,
            providerMaintenanceRunner.updateProvider(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverResolveProviderUpdateBlockers]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverResolveProviderUpdateBlockers,
            providerMaintenanceRunner.resolveUpdateBlockers(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverRemoveKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverRemoveKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(Effect.map(redactServerSettingsForClient)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            serverSettings.updateSettings(patch).pipe(Effect.map(redactServerSettingsForClient)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverDiscoverSourceControl,
            Effect.sync(() => refreshWindowsPath()).pipe(
              Effect.andThen(sourceControlDiscovery.discover),
            ),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetSourceControlSetup]: () =>
          Effect.all({
            tools: sourceControlToolMaintenance.getState,
            githubAuth: githubAuth.getState,
          }),
        [WS_METHODS.serverStartGitHubAuth]: () => githubAuth.start,
        [WS_METHODS.serverCancelGitHubAuth]: () => githubAuth.cancel,
        [WS_METHODS.serverUpdateSourceControlTool]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSourceControlTool,
            Effect.gen(function* () {
              const operation = input.operation ?? "update";
              const before = yield* sourceControlDiscovery.discover;
              if (
                !SourceControlToolMaintenance.hasVerifiedSourceControlToolUpdateAction(
                  before,
                  input.target,
                  operation,
                )
              ) {
                return yield* new SourceControlToolUpdateError({
                  target: input.target,
                  reason:
                    "Threadlines could not verify an available install or update action for this tool. Rescan the server environment and try again.",
                });
              }
              const previousVersion = SourceControlToolMaintenance.currentSourceControlToolVersion(
                before,
                input.target,
              );

              const maintenanceResult = yield* sourceControlToolMaintenance.update(
                {
                  ...input,
                  operation,
                },
                () =>
                  sourceControlDiscovery.discover.pipe(
                    Effect.flatMap((after) =>
                      SourceControlToolMaintenance.currentSourceControlToolVersion(
                        after,
                        input.target,
                      ) !== null
                        ? Effect.void
                        : Effect.fail(
                            new SourceControlToolUpdateError({
                              target: input.target,
                              reason:
                                "The installer finished, but the tool could not be found. Check the installer, then rescan or retry.",
                            }),
                          ),
                    ),
                    Effect.andThen(() =>
                      input.target === "git" && operation === "install"
                        ? githubAuth.configureGit.pipe(
                            Effect.mapError(
                              (error) =>
                                new SourceControlToolUpdateError({
                                  target: input.target,
                                  reason: error.detail,
                                }),
                            ),
                          )
                        : Effect.void,
                    ),
                  ),
              );

              const discovery = yield* sourceControlDiscovery.discover;
              const currentVersion = SourceControlToolMaintenance.currentSourceControlToolVersion(
                discovery,
                input.target,
              );
              if (currentVersion === null) {
                return yield* new SourceControlToolUpdateError({
                  target: input.target,
                  reason:
                    "The installer finished, but the tool could not be found. Check the installer, then rescan or retry.",
                });
              }

              return {
                target: input.target,
                operation,
                status:
                  previousVersion !== currentVersion
                    ? "succeeded"
                    : maintenanceResult.status === "started"
                      ? "started"
                      : "unchanged",
                previousVersion,
                currentVersion,
                discovery,
              } as const;
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetTraceDiagnostics,
            TraceDiagnostics.readTraceDiagnostics({
              traceFilePath: config.serverTracePath,
              maxFiles: config.traceMaxFiles,
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProcessDiagnostics,
            processResourceMonitor.readCurrent,
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProcessResourceHistory,
            processResourceMonitor.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverSignalProcess]: (input) =>
          observeRpcEffect(WS_METHODS.serverSignalProcess, processDiagnostics.signal(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverResolveBackgroundRuns]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverResolveBackgroundRuns,
            processDiagnostics.resolveBackgroundRuns(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverStopBackgroundRun]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverStopBackgroundRun,
            processDiagnostics.stopBackgroundRun(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverReadBackgroundRunOutput]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverReadBackgroundRunOutput,
            readBackgroundRunOutput(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetProviderExtensions]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProviderExtensions,
            Effect.gen(function* () {
              const [settings, providers] = yield* Effect.all(
                [serverSettings.getSettings, providerRegistry.getProviders],
                { concurrency: "unbounded" },
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderExtensionsError({
                      message: cause.message,
                      cause,
                    }),
                ),
              );
              return yield* readProviderExtensionsInventory({
                request: input,
                settings,
                providers,
              });
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverStartProviderExtensionMcpOAuth]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverStartProviderExtensionMcpOAuth,
            Effect.gen(function* () {
              const settings = yield* loadProviderExtensionSettings;
              return yield* startProviderExtensionMcpOAuth({ request: input, settings });
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetProviderExtensionOperationStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProviderExtensionOperationStatus,
            getProviderExtensionOperationStatus(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverReloadProviderExtensionMcpServers]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverReloadProviderExtensionMcpServers,
            Effect.gen(function* () {
              const settings = yield* loadProviderExtensionSettings;
              return yield* reloadProviderExtensionMcpServers({ request: input, settings });
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverSetProviderExtensionSkillEnabled]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverSetProviderExtensionSkillEnabled,
            Effect.gen(function* () {
              const settings = yield* loadProviderExtensionSettings;
              return yield* setProviderExtensionSkillEnabled({ request: input, settings }).pipe(
                Effect.tap(() => noteExtensionsChanged(input)),
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverReadProviderExtensionSkill]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverReadProviderExtensionSkill,
            Effect.gen(function* () {
              const settings = yield* loadProviderExtensionSettings;
              return yield* readProviderExtensionSkill({ request: input, settings });
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCreateProviderExtensionSkill]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCreateProviderExtensionSkill,
            Effect.gen(function* () {
              const settings = yield* loadProviderExtensionSettings;
              return yield* createProviderExtensionSkill({ request: input, settings }).pipe(
                Effect.tap(() => noteExtensionsChanged(input)),
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverDeleteProviderExtensionSkill]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverDeleteProviderExtensionSkill,
            Effect.gen(function* () {
              const settings = yield* loadProviderExtensionSettings;
              return yield* deleteProviderExtensionSkill({ request: input, settings }).pipe(
                Effect.tap(() => noteExtensionsChanged(input)),
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverReadProviderExtensionPlugin]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverReadProviderExtensionPlugin,
            Effect.gen(function* () {
              const settings = yield* loadProviderExtensionSettings;
              return yield* readProviderExtensionPlugin({ request: input, settings });
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverInstallProviderExtensionPlugin]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverInstallProviderExtensionPlugin,
            Effect.gen(function* () {
              const settings = yield* loadProviderExtensionSettings;
              return yield* installProviderExtensionPlugin({ request: input, settings }).pipe(
                Effect.tap(() => noteExtensionsChanged(input)),
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUninstallProviderExtensionPlugin]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUninstallProviderExtensionPlugin,
            Effect.gen(function* () {
              const settings = yield* loadProviderExtensionSettings;
              return yield* uninstallProviderExtensionPlugin({ request: input, settings }).pipe(
                Effect.tap(() => noteExtensionsChanged(input)),
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverSetProviderExtensionPluginEnabled]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverSetProviderExtensionPluginEnabled,
            Effect.gen(function* () {
              const settings = yield* loadProviderExtensionSettings;
              return yield* setProviderExtensionPluginEnabled({ request: input, settings }).pipe(
                Effect.tap(() => noteExtensionsChanged(input)),
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpdateProviderExtensionPlugin]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateProviderExtensionPlugin,
            Effect.gen(function* () {
              const settings = yield* loadProviderExtensionSettings;
              return yield* updateProviderExtensionPlugin({ request: input, settings }).pipe(
                Effect.tap(() => noteExtensionsChanged(input)),
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverRefreshProviderExtensionPluginMarketplaces]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviderExtensionPluginMarketplaces,
            Effect.gen(function* () {
              const settings = yield* loadProviderExtensionSettings;
              return yield* refreshProviderExtensionPluginMarketplaces({
                request: input,
                settings,
              }).pipe(Effect.tap(() => noteExtensionsChanged(input)));
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverAddProviderExtensionMarketplace]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverAddProviderExtensionMarketplace,
            Effect.gen(function* () {
              const settings = yield* loadProviderExtensionSettings;
              return yield* addProviderExtensionMarketplace({ request: input, settings });
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverRemoveProviderExtensionMarketplace]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRemoveProviderExtensionMarketplace,
            Effect.gen(function* () {
              const settings = yield* loadProviderExtensionSettings;
              return yield* removeProviderExtensionMarketplace({ request: input, settings }).pipe(
                Effect.tap(() => noteExtensionsChanged(input)),
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCallProviderExtensionMcpTool]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCallProviderExtensionMcpTool,
            Effect.gen(function* () {
              const settings = yield* loadProviderExtensionSettings;
              return yield* callProviderExtensionMcpTool({ request: input, settings });
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverReadProviderExtensionMcpResource]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverReadProviderExtensionMcpResource,
            Effect.gen(function* () {
              const settings = yield* loadProviderExtensionSettings;
              return yield* readProviderExtensionMcpResource({ request: input, settings });
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetProviderInstructionFiles]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProviderInstructionFiles,
            readProviderInstructionFiles(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverWriteProviderInstructionFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverWriteProviderInstructionFile,
            writeInstructionFile(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.usageSummary]: (input) =>
          observeRpcEffect(WS_METHODS.usageSummary, usage.readSummary(input), {
            "rpc.aggregate": "usage",
          }),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlLookupRepository,
            sourceControlRepositories.lookupRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlListRepositories]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlListRepositories,
            sourceControlRepositories.listRepositories(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlCloneRepository,
            sourceControlRepositories.cloneRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlPublishRepository,
            sourceControlRepositories
              .publishRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            workspaceEntries.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchEntriesError({
                    message: `Failed to search workspace entries: ${cause.detail}`,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            workspaceFileSystem.writeFile(input).pipe(
              Effect.mapError((cause) => {
                const message = isWorkspacePathOutsideRootError(cause)
                  ? "Workspace file path must stay within the project root."
                  : "Failed to write workspace file";
                return new ProjectWriteFileError({
                  message,
                  cause,
                });
              }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsListEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsListEntries,
            workspaceEntries.list(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectListEntriesError({
                    message: `Failed to list workspace entries: ${cause.detail}`,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsReadFile,
            workspaceFileSystem.readFile(input).pipe(
              Effect.mapError((cause) => {
                const message = isWorkspacePathOutsideRootError(cause)
                  ? "Workspace file path must stay within the project root."
                  : `Failed to read workspace file: ${cause.detail}`;
                return new ProjectReadFileError({
                  message,
                  cause,
                });
              }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        // Relay-paired clients (phonelink) have no HTTP path to this server,
        // so the `/api/project-favicon` route is unreachable for them; this
        // RPC is their favicon transport. A null favicon means "no icon
        // found" — the client renders its own fallback glyph.
        [WS_METHODS.projectsFavicon]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsFavicon,
            Effect.gen(function* () {
              const faviconFilePath = yield* projectFaviconResolver.resolvePath(input.cwd);
              if (!faviconFilePath) {
                return { favicon: null };
              }
              const bytes = yield* fileSystem.readFile(faviconFilePath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProjectFaviconError({
                      message: `Failed to read project favicon for ${input.cwd}.`,
                      cause,
                    }),
                ),
              );
              const extension = NodePath.extname(faviconFilePath).toLowerCase();
              return {
                favicon: {
                  mimeType: IMAGE_MIME_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream",
                  base64: Buffer.from(bytes).toString("base64"),
                },
              };
            }),
            { "rpc.aggregate": "workspace" },
          ),
        // Relay-paired clients (phonelink) have no HTTP path to this server,
        // so the `/attachments` route is unreachable for them; this RPC is
        // their transport for stored attachment bytes.
        [WS_METHODS.attachmentsRead]: (input) =>
          observeRpcEffect(
            WS_METHODS.attachmentsRead,
            Effect.gen(function* () {
              const filePath = resolveAttachmentPathById({
                attachmentsDir: config.attachmentsDir,
                attachmentId: input.attachmentId,
              });
              if (!filePath) {
                return yield* new ChatAttachmentReadError({
                  message: `Attachment ${input.attachmentId} was not found.`,
                });
              }
              const bytes = yield* fileSystem.readFile(filePath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ChatAttachmentReadError({
                      message: `Failed to read attachment ${input.attachmentId}.`,
                      cause,
                    }),
                ),
              );
              const extension = NodePath.extname(filePath).toLowerCase();
              return {
                attachmentId: input.attachmentId,
                mimeType:
                  IMAGE_MIME_TYPE_BY_EXTENSION[extension] ??
                  fileAttachmentMimeTypeForExtension(extension) ??
                  "application/octet-stream",
                base64: Buffer.from(bytes).toString("base64"),
                sizeBytes: bytes.byteLength,
              };
            }),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.visualizationsRead]: (input) =>
          observeRpcEffect(
            WS_METHODS.visualizationsRead,
            Effect.gen(function* () {
              const threadOption = yield* projectionSnapshotQuery
                .getThreadShellById(input.threadId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new CodexInlineVisualizationReadError({
                        message: "The visualization thread could not be loaded.",
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(threadOption)) {
                return yield* new CodexInlineVisualizationReadError({
                  message: "The visualization thread was not found.",
                });
              }

              const thread = threadOption.value;
              const providerThreadId = thread.session?.providerThreadId;
              if (!providerThreadId) {
                return yield* new CodexInlineVisualizationReadError({
                  message: "This thread does not have a native Codex session.",
                });
              }

              const providerInstanceId =
                thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
              const settings = yield* serverSettings.getSettings.pipe(
                Effect.mapError(
                  (cause) =>
                    new CodexInlineVisualizationReadError({
                      message: "The Codex provider settings could not be loaded.",
                      cause,
                    }),
                ),
              );
              const providerConfig = deriveProviderInstanceConfigMap(settings)[providerInstanceId];
              if (!providerConfig || providerConfig.driver !== ProviderDriverKind.make("codex")) {
                return yield* new CodexInlineVisualizationReadError({
                  message: "This thread is not backed by a configured Codex provider.",
                });
              }

              const codexSettings = yield* decodeCodexSettings(providerConfig.config ?? {}).pipe(
                Effect.mapError(
                  (cause) =>
                    new CodexInlineVisualizationReadError({
                      message: "The Codex provider settings are invalid.",
                      cause,
                    }),
                ),
              );
              const homeLayout = yield* resolveCodexHomeLayout(codexSettings);
              return yield* readCodexInlineVisualization({
                codexHomePath: homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath,
                providerThreadId,
                file: input.file,
              });
            }),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, externalLauncher.launchEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
            workspaceEntries.browse(input).pipe(
              Effect.mapError(
                (cause) =>
                  new FilesystemBrowseError({
                    message: cause.detail,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.previewAutomationConnect]: (input) =>
          // Scoped to the subscription: when the client goes -- panel closed,
          // tab gone, socket dropped -- the scope closes, the broker forgets
          // the host, and anything still waiting on it stops waiting.
          observeRpcStreamEffect(
            WS_METHODS.previewAutomationConnect,
            previewAutomationBroker.connect(input),
            { "rpc.aggregate": "preview" },
          ),
        [WS_METHODS.previewAutomationRespond]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationRespond,
            previewAutomationBroker.respond(input),
            { "rpc.aggregate": "preview" },
          ),
        [WS_METHODS.previewAutomationConnectClient]: (input) =>
          // Scoped like the per-thread host: the socket going is the client going.
          observeRpcStreamEffect(
            WS_METHODS.previewAutomationConnectClient,
            previewAutomationBroker.connectClient(input),
            { "rpc.aggregate": "preview" },
          ),
        [WS_METHODS.previewAutomationClaim]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationClaim,
            previewAutomationBroker.claim(input),
            { "rpc.aggregate": "preview" },
          ),
        [WS_METHODS.previewAutomationProgress]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationProgress,
            previewAutomationBroker.progress(input),
            { "rpc.aggregate": "preview" },
          ),
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeVcsStatus,
            vcsStatusBroadcaster.streamStatus(input, {
              automaticRemoteRefreshInterval: automaticGitFetchInterval,
            }),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRefreshStatus,
            vcsStatusBroadcaster.refreshStatus(input.cwd),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsRefreshLocalStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRefreshLocalStatus,
            vcsStatusBroadcaster.refreshLocalStatus(input.cwd),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsPull,
            gitWorkflow.pullCurrentBranch(input).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) =>
                  refreshGitStatus(input.cwd).pipe(
                    Effect.ignore({ log: true }),
                    Effect.andThen(Effect.failCause(cause)),
                  ),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsListStashes]: (input) =>
          observeRpcEffect(WS_METHODS.vcsListStashes, gitWorkflow.listStashes(input), {
            "rpc.aggregate": "git",
          }),
        [WS_METHODS.vcsCreateStash]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateStash,
            gitWorkflow.createStash(input).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) =>
                  refreshGitStatus(input.cwd).pipe(
                    Effect.ignore({ log: true }),
                    Effect.andThen(Effect.failCause(cause)),
                  ),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsApplyStash]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsApplyStash,
            gitWorkflow.applyStash(input).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) =>
                  refreshGitStatus(input.cwd).pipe(
                    Effect.ignore({ log: true }),
                    Effect.andThen(Effect.failCause(cause)),
                  ),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsDropStash]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsDropStash,
            gitWorkflow.dropStash(input).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) =>
                  refreshGitStatus(input.cwd).pipe(
                    Effect.ignore({ log: true }),
                    Effect.andThen(Effect.failCause(cause)),
                  ),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
            Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
              gitWorkflow
                .runStackedAction(input, {
                  actionId: input.actionId,
                  progressReporter: {
                    publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                  },
                })
                .pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) =>
                      refreshGitStatus(input.cwd).pipe(
                        Effect.andThen(Queue.failCause(queue, cause)),
                      ),
                    onSuccess: () =>
                      refreshGitStatus(input.cwd).pipe(
                        Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                      ),
                  }),
                ),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.gitGenerateCommitMessage]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitGenerateCommitMessage,
            gitWorkflow.generateCommitMessage(input),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolvePullRequest,
            gitWorkflow.resolvePullRequest(input),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            gitWorkflow
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitAuthRemediationPlan]: (input) =>
          observeRpcEffect(WS_METHODS.gitAuthRemediationPlan, gitAuthRemediation.plan(input), {
            "rpc.aggregate": "git",
          }),
        [WS_METHODS.gitApplyAuthRemediation]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitApplyAuthRemediation,
            gitAuthRemediation.apply(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.pullRequestsList]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsList, pullRequests.list(input), {
            "rpc.aggregate": "pullRequests",
          }),
        [WS_METHODS.pullRequestsDetail]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsDetail, pullRequests.detail(input), {
            "rpc.aggregate": "pullRequests",
          }),
        [WS_METHODS.pullRequestsActivity]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsActivity, pullRequests.activity(input), {
            "rpc.aggregate": "pullRequests",
          }),
        [WS_METHODS.pullRequestsDiff]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsDiff, pullRequests.diff(input), {
            "rpc.aggregate": "pullRequests",
          }),
        [WS_METHODS.pullRequestsComment]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsComment, pullRequests.comment(input), {
            "rpc.aggregate": "pullRequests",
          }),
        [WS_METHODS.pullRequestsRunAction]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsRunAction, pullRequests.runAction(input), {
            "rpc.aggregate": "pullRequests",
          }),
        [WS_METHODS.pullRequestsSubmitReview]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsSubmitReview, pullRequests.submitReview(input), {
            "rpc.aggregate": "pullRequests",
          }),
        [WS_METHODS.pullRequestsReplyToThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsReplyToThread,
            pullRequests.replyToThread(input),
            {
              "rpc.aggregate": "pullRequests",
            },
          ),
        [WS_METHODS.pullRequestsSetThreadResolution]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsSetThreadResolution,
            pullRequests.setThreadResolution(input),
            { "rpc.aggregate": "pullRequests" },
          ),
        [WS_METHODS.pullRequestsSetReaction]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsSetReaction, pullRequests.setReaction(input), {
            "rpc.aggregate": "pullRequests",
          }),
        [WS_METHODS.pullRequestsUpdate]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsUpdate, pullRequests.update(input), {
            "rpc.aggregate": "pullRequests",
          }),
        [WS_METHODS.pullRequestsUpdateComment]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsUpdateComment,
            pullRequests.updateComment(input),
            {
              "rpc.aggregate": "pullRequests",
            },
          ),
        [WS_METHODS.pullRequestsReviewerCandidates]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsReviewerCandidates,
            pullRequests.reviewerCandidates(input),
            { "rpc.aggregate": "pullRequests" },
          ),
        [WS_METHODS.pullRequestsRequestReviewers]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsRequestReviewers,
            pullRequests.requestReviewers(input),
            { "rpc.aggregate": "pullRequests" },
          ),
        [WS_METHODS.vcsListRefs]: (input) =>
          observeRpcEffect(WS_METHODS.vcsListRefs, gitWorkflow.listRefs(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsCommitGraph]: (input) =>
          observeRpcEffect(WS_METHODS.vcsCommitGraph, gitWorkflow.commitGraph(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsCommitDetails]: (input) =>
          observeRpcEffect(WS_METHODS.vcsCommitDetails, gitWorkflow.commitDetails(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsWorkingTreeDiff]: (input) =>
          observeRpcEffect(WS_METHODS.vcsWorkingTreeDiff, gitWorkflow.workingTreeDiff(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsDiscardChanges]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsDiscardChanges,
            gitWorkflow.discardChanges(input).pipe(Effect.ensuring(refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsStageChanges]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsStageChanges,
            gitWorkflow.stageChanges(input).pipe(Effect.ensuring(refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsUnstageChanges]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsUnstageChanges,
            gitWorkflow.unstageChanges(input).pipe(Effect.ensuring(refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateWorktree,
            gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsListWorktrees]: (input) =>
          observeRpcEffect(WS_METHODS.vcsListWorktrees, gitWorkflow.listWorktreeStatuses(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRemoveWorktree,
            // Guarded before the git call, not after: once the directory is
            // gone the thread that lived in it has no way back.
            ensureWorktreeRemovable({
              worktreePath: input.path,
              readThreads: projectionSnapshotQuery
                .getShellSnapshot()
                .pipe(Effect.map((snapshot) => snapshot.threads)),
            }).pipe(
              Effect.andThen(
                gitWorkflow
                  .removeWorktree(input)
                  .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
              ),
              // The client shows a one-line summary; the log keeps the rest.
              Effect.tapError((error) =>
                Effect.logWarning("worktree removal failed", {
                  cwd: input.cwd,
                  worktreePath: input.path,
                  detail: error.message,
                }),
              ),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateRef,
            gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateTag]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateTag,
            gitWorkflow.createTag(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsDeleteBranch]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsDeleteBranch,
            gitWorkflow.deleteBranch(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsSwitchRef,
            gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsMergeRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsMergeRef,
            gitWorkflow.mergeRef(input).pipe(Effect.ensuring(refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsInit,
            vcsProvisioning
              .initRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalWrite]: (input) =>
          observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalResize]: (input) =>
          observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClear]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(WS_METHODS.terminalRestart, terminalManager.restart(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClose]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalEvents,
            Stream.callback<TerminalEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribe((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.providerAuthStart]: (input) =>
          observeRpcEffect(WS_METHODS.providerAuthStart, providerAuthSessions.start(input), {
            "rpc.aggregate": "providerAuth",
          }),
        [WS_METHODS.providerAuthWrite]: (input) =>
          observeRpcEffect(WS_METHODS.providerAuthWrite, providerAuthSessions.write(input), {
            "rpc.aggregate": "providerAuth",
          }),
        [WS_METHODS.providerAuthResize]: (input) =>
          observeRpcEffect(WS_METHODS.providerAuthResize, providerAuthSessions.resize(input), {
            "rpc.aggregate": "providerAuth",
          }),
        [WS_METHODS.providerAuthStop]: (input) =>
          observeRpcEffect(WS_METHODS.providerAuthStop, providerAuthSessions.stop(input), {
            "rpc.aggregate": "providerAuth",
          }),
        [WS_METHODS.providerAuthSubscribe]: (input) =>
          observeRpcStream(
            WS_METHODS.providerAuthSubscribe,
            Stream.callback<ProviderAuthEvent>((queue) =>
              Effect.acquireRelease(
                providerAuthSessions.subscribe(input.instanceId, (event) =>
                  Queue.offer(queue, event),
                ),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "providerAuth" },
          ),
        [WS_METHODS.realtimeAppendAudio]: (input) =>
          observeRpcEffect(
            WS_METHODS.realtimeAppendAudio,
            providerService.realtimeAppendAudio!(input).pipe(
              Effect.mapError(
                (error) =>
                  new ProviderRealtimeError({
                    message:
                      error.message.trim().length > 0
                        ? error.message
                        : "Failed to append realtime audio.",
                  }),
              ),
            ),
            { "rpc.aggregate": "realtime" },
          ),
        [WS_METHODS.realtimeSubscribeAudio]: (input) =>
          observeRpcStream(
            WS_METHODS.realtimeSubscribeAudio,
            realtimeAudioHub.subscribe(input.threadId),
            { "rpc.aggregate": "realtime" },
          ),
        [WS_METHODS.dictationSubscribeStatus]: (_input) =>
          observeRpcStream(WS_METHODS.dictationSubscribeStatus, dictation.streamChanges, {
            "rpc.aggregate": "dictation",
          }),
        [WS_METHODS.dictationDownloadModel]: (input) =>
          observeRpcEffect(
            WS_METHODS.dictationDownloadModel,
            dictation.downloadModel(input.model),
            {
              "rpc.aggregate": "dictation",
            },
          ),
        [WS_METHODS.dictationCancelDownload]: (input) =>
          observeRpcEffect(
            WS_METHODS.dictationCancelDownload,
            dictation.cancelDownload(input.model),
            { "rpc.aggregate": "dictation" },
          ),
        [WS_METHODS.dictationRemoveModel]: (input) =>
          observeRpcEffect(WS_METHODS.dictationRemoveModel, dictation.removeModel(input.model), {
            "rpc.aggregate": "dictation",
          }),
        [WS_METHODS.dictationWarmUp]: (_input) =>
          observeRpcEffect(WS_METHODS.dictationWarmUp, dictation.warmUp, {
            "rpc.aggregate": "dictation",
          }),
        [WS_METHODS.dictationTranscribe]: (input) =>
          observeRpcEffect(WS_METHODS.dictationTranscribe, dictation.transcribe(input), {
            "rpc.aggregate": "dictation",
          }),
        [WS_METHODS.subscribeServerConfig]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = providerRegistry.streamChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(providerStatuses, settingsUpdates),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: yield* loadServerConfig,
                }),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = lifecycleEvents.stream.pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeRelayAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeRelayAccess,
            requireOwner(WS_METHODS.subscribeRelayAccess).pipe(Effect.as(relayHost.snapshots)),
            { "rpc.aggregate": "auth" },
          ),
        [WS_METHODS.relayCreateInvite]: (_input) =>
          observeRpcEffect(
            WS_METHODS.relayCreateInvite,
            requireOwner(WS_METHODS.relayCreateInvite).pipe(Effect.andThen(relayHost.createInvite)),
            { "rpc.aggregate": "auth" },
          ),
        [WS_METHODS.relayCancelInvite]: (input) =>
          observeRpcEffect(
            WS_METHODS.relayCancelInvite,
            requireOwner(WS_METHODS.relayCancelInvite).pipe(
              Effect.andThen(relayHost.cancelInvite(input.inviteId)),
            ),
            { "rpc.aggregate": "auth" },
          ),
        [WS_METHODS.relayRespondToJoinRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.relayRespondToJoinRequest,
            requireOwner(WS_METHODS.relayRespondToJoinRequest).pipe(
              Effect.andThen(relayHost.respondToJoinRequest(input)),
            ),
            { "rpc.aggregate": "auth" },
          ),
        [WS_METHODS.relaySubmitJoin]: (input) =>
          observeRpcEffect(WS_METHODS.relaySubmitJoin, relayHost.submitJoin(input), {
            "rpc.aggregate": "auth",
          }),
        [WS_METHODS.relayDirectRoutes]: (_input) =>
          observeRpcEffect(
            WS_METHODS.relayDirectRoutes,
            relayHost.directRoutes(currentSessionId).pipe(Effect.map((routes) => ({ routes }))),
            { "rpc.aggregate": "auth" },
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* () {
              yield* requireOwner(WS_METHODS.subscribeAuthAccess);
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                BootstrapCredentialChange | SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges).pipe(
                // Same visibility rule as ServerAuth.listClientSessions: internal
                // machine-to-machine sessions never reach device-list subscribers.
                Stream.filter(
                  (change) =>
                    change.type !== "clientUpserted" ||
                    change.clientSession.sessionId === currentSessionId ||
                    !isInternalClientSession(change.clientSession),
                ),
              );

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
      });
    }),
  );

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const maintenance = yield* SourceControlToolMaintenance.SourceControlToolMaintenance;
    const providerMaintenance = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
    const githubSignIn = yield* GitHubAuth.GitHubAuth;
    const threadBootstrap = yield* ThreadBootstrap;
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request);
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
          disableTracing: true,
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(session).pipe(
              Layer.provide(
                Layer.succeed(
                  SourceControlToolMaintenance.SourceControlToolMaintenance,
                  maintenance,
                ),
              ),
              Layer.provide(
                Layer.succeed(
                  ProviderMaintenanceRunner.ProviderMaintenanceRunner,
                  providerMaintenance,
                ),
              ),
              Layer.provide(Layer.succeed(GitHubAuth.GitHubAuth, githubSignIn)),
              Layer.provide(Layer.succeed(ThreadBootstrap, threadBootstrap)),
              Layer.provideMerge(RpcSerialization.layerJson),
              Layer.provide(
                SourceControlDiscoveryLayer.layer.pipe(
                  Layer.provide(
                    SourceControlProviderRegistry.layer.pipe(
                      Layer.provide(
                        Layer.mergeAll(
                          AzureDevOpsCli.layer,
                          BitbucketApi.layer,
                          GitHubCli.layer,
                          GitLabCli.layer,
                        ),
                      ),
                      Layer.provideMerge(GitVcsDriver.layer),
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
                      ),
                    ),
                  ),
                  Layer.provide(VcsProcess.layer),
                ),
              ),
            ),
          ),
        );
        // Revoking a device only rewrites persistence, so a phone that is
        // already connected would keep streaming live orchestration state on
        // its existing socket until it happened to reconnect. Racing the served
        // socket against the revocation watcher drops the connection the moment
        // access is taken away; `awaitRevoked` never resolves for a session that
        // stays valid, so a healthy socket is unaffected.
        const closeWhenRevoked = sessions.awaitRevoked(session.sessionId).pipe(
          Effect.tap(() =>
            Effect.logInfo("auth.session.revoked.closing-websocket", {
              sessionId: session.sessionId,
            }),
          ),
          Effect.as(HttpServerResponse.empty({ status: 401 })),
          // A failing watcher must never take down a socket the owner still
          // trusts, so log it and let the socket decide the outcome.
          Effect.catchCause((cause) =>
            Effect.logWarning("auth.session.revocation-watch-failed", {
              sessionId: session.sessionId,
              cause,
            }).pipe(Effect.andThen(Effect.never)),
          ),
        );

        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => Effect.raceFirst(rpcWebSocketHttpEffect, closeWhenRevoked),
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(Effect.scoped, Effect.catchTag("AuthError", respondToAuthError)),
    );
  }),
);
