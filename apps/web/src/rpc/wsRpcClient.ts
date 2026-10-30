import {
  type GitActionProgressEvent,
  type GitGenerateCommitMessageInput,
  type GitGenerateCommitMessageResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusResult,
  type VcsStatusStreamEvent,
  type LocalApi,
  ORCHESTRATION_WS_METHODS,
  type ProviderStartReviewInput,
  type ProviderExternalThreadImportInput,
  type ProviderExternalThreadImportResult,
  type ProviderExternalThreadListInput,
  type ProviderExternalThreadListResult,
  type ProviderSubagentInputRequest,
  type ProviderSubagentInputResult,
  type ProviderSubagentTranscriptInput,
  type ProviderSubagentTranscriptResult,
  type ProviderStartReviewResult,
  type ScheduledTaskClientSupport,
  type ServerSettingsPatch,
  WS_METHODS,
} from "@threadlines/contracts";
import { applyGitStatusStreamEvent } from "@threadlines/shared/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { type WsRpcProtocolClient } from "./protocol";
import { resetWsReconnectBackoff } from "./wsConnectionState";
import { WsTransport } from "./wsTransport";

type RpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends RpcTag> = WsRpcProtocolClient[TTag];
type RpcInput<TTag extends RpcTag> = Parameters<RpcMethod<TTag>>[0];

interface StreamSubscriptionOptions {
  readonly onResubscribe?: () => void;
  /**
   * Fires when a non-resubscribing stream ends for any reason other than
   * unsubscribe, with what it failed with when it failed.
   */
  readonly onComplete?: (failure?: unknown) => void;
  /** Fires when a stream attempt failed and the transport is about to retry. */
  readonly onRetry?: (error: unknown, attempt: number) => void;
}

/** How long a polled read of a command's output may take. */
const OUTPUT_READ_TIMEOUT = Option.some("5 seconds" as const);
/** An MCP app card's load or tool call (see loadMcpApp). */
const MCP_APP_REQUEST_TIMEOUT = Option.some("2 minutes" as const);
/**
 * The scheduled-task kinds this app can show: a server leaves event tasks and
 * their runs out for a client that doesn't name `webhook`.
 */
const SCHEDULED_TASK_CLIENT_SUPPORT: ScheduledTaskClientSupport = ["webhook"];

type RpcUnaryMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? (input: RpcInput<TTag>) => Promise<TSuccess>
    : never;

type RpcUnaryNoArgMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? () => Promise<TSuccess>
    : never;

type RpcStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (listener: (event: TEvent) => void, options?: StreamSubscriptionOptions) => () => void
    : never;

type RpcInputStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (
        input: RpcInput<TTag>,
        listener: (event: TEvent) => void,
        options?: StreamSubscriptionOptions,
      ) => () => void
    : never;

interface GitRunStackedActionOptions {
  readonly onProgress?: (event: GitActionProgressEvent) => void;
}

export interface WsRpcClient {
  readonly dispose: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly isHeartbeatFresh: () => boolean;
  readonly terminal: {
    readonly open: RpcUnaryMethod<typeof WS_METHODS.terminalOpen>;
    readonly write: RpcUnaryMethod<typeof WS_METHODS.terminalWrite>;
    readonly resize: RpcUnaryMethod<typeof WS_METHODS.terminalResize>;
    readonly clear: RpcUnaryMethod<typeof WS_METHODS.terminalClear>;
    readonly restart: RpcUnaryMethod<typeof WS_METHODS.terminalRestart>;
    readonly close: RpcUnaryMethod<typeof WS_METHODS.terminalClose>;
    readonly resolveInterrupted: RpcUnaryMethod<typeof WS_METHODS.terminalResolveInterrupted>;
    readonly resolvePortInUse: RpcUnaryMethod<typeof WS_METHODS.terminalResolvePortInUse>;
    readonly onEvent: RpcInputStreamMethod<typeof WS_METHODS.subscribeTerminalEvents>;
  };
  /** Settings-owned provider sign-in, run in an ephemeral server-side PTY. */
  readonly providerAuth: {
    readonly start: RpcUnaryMethod<typeof WS_METHODS.providerAuthStart>;
    readonly write: RpcUnaryMethod<typeof WS_METHODS.providerAuthWrite>;
    readonly resize: RpcUnaryMethod<typeof WS_METHODS.providerAuthResize>;
    readonly stop: RpcUnaryMethod<typeof WS_METHODS.providerAuthStop>;
    readonly respond: RpcUnaryMethod<typeof WS_METHODS.providerAuthRespond>;
    readonly subscribe: RpcInputStreamMethod<typeof WS_METHODS.providerAuthSubscribe>;
  };
  readonly realtime: {
    readonly appendAudio: RpcUnaryMethod<typeof WS_METHODS.realtimeAppendAudio>;
    readonly subscribeAudio: RpcInputStreamMethod<typeof WS_METHODS.realtimeSubscribeAudio>;
  };
  /** Composer dictation: model downloads and server-side speech-to-text. */
  readonly dictation: {
    readonly subscribeStatus: RpcStreamMethod<typeof WS_METHODS.dictationSubscribeStatus>;
    readonly downloadModel: RpcUnaryMethod<typeof WS_METHODS.dictationDownloadModel>;
    readonly cancelDownload: RpcUnaryMethod<typeof WS_METHODS.dictationCancelDownload>;
    readonly removeModel: RpcUnaryMethod<typeof WS_METHODS.dictationRemoveModel>;
    readonly warmUp: RpcUnaryNoArgMethod<typeof WS_METHODS.dictationWarmUp>;
    readonly transcribe: RpcUnaryMethod<typeof WS_METHODS.dictationTranscribe>;
  };
  /** Offering this client's browser panel as the page the agent acts on. */
  readonly previewAutomation: {
    readonly connect: RpcInputStreamMethod<typeof WS_METHODS.previewAutomationConnect>;
    readonly respond: RpcUnaryMethod<typeof WS_METHODS.previewAutomationRespond>;
    readonly progress: RpcUnaryMethod<typeof WS_METHODS.previewAutomationProgress>;
    readonly connectClient: RpcInputStreamMethod<typeof WS_METHODS.previewAutomationConnectClient>;
    readonly claim: RpcUnaryMethod<typeof WS_METHODS.previewAutomationClaim>;
    readonly active: RpcUnaryMethod<typeof WS_METHODS.previewAutomationActive>;
  };
  /** The browser's way to the environment's own `localhost`, from another computer. */
  readonly previewLoopback: {
    readonly open: RpcInputStreamMethod<typeof WS_METHODS.previewTunnelOpen>;
    readonly write: RpcUnaryMethod<typeof WS_METHODS.previewTunnelWrite>;
    readonly credit: RpcUnaryMethod<typeof WS_METHODS.previewTunnelCredit>;
    readonly localServers: RpcUnaryNoArgMethod<typeof WS_METHODS.previewLocalServers>;
  };
  readonly projects: {
    readonly searchEntries: RpcUnaryMethod<typeof WS_METHODS.projectsSearchEntries>;
    readonly writeFile: RpcUnaryMethod<typeof WS_METHODS.projectsWriteFile>;
    readonly listEntries: RpcUnaryMethod<typeof WS_METHODS.projectsListEntries>;
    readonly readFile: RpcUnaryMethod<typeof WS_METHODS.projectsReadFile>;
    readonly favicon: RpcUnaryMethod<typeof WS_METHODS.projectsFavicon>;
  };
  readonly attachments: {
    readonly read: RpcUnaryMethod<typeof WS_METHODS.attachmentsRead>;
  };
  readonly visualizations: {
    readonly read: RpcUnaryMethod<typeof WS_METHODS.visualizationsRead>;
  };
  readonly pages: {
    readonly read: RpcUnaryMethod<typeof WS_METHODS.pagesRead>;
  };
  readonly commandRuns: {
    readonly start: RpcUnaryMethod<typeof WS_METHODS.commandRunsStart>;
    readonly sendOutput: RpcUnaryMethod<typeof WS_METHODS.commandRunsSendOutput>;
  };
  readonly filesystem: {
    readonly browse: RpcUnaryMethod<typeof WS_METHODS.filesystemBrowse>;
  };
  readonly usage: {
    readonly summary: RpcUnaryMethod<typeof WS_METHODS.usageSummary>;
    readonly breakdowns: RpcUnaryNoArgMethod<typeof WS_METHODS.usageBreakdowns>;
  };
  readonly sourceControl: {
    readonly lookupRepository: RpcUnaryMethod<typeof WS_METHODS.sourceControlLookupRepository>;
    readonly listRepositories: RpcUnaryMethod<typeof WS_METHODS.sourceControlListRepositories>;
    readonly cloneRepository: RpcUnaryMethod<typeof WS_METHODS.sourceControlCloneRepository>;
    readonly publishRepository: RpcUnaryMethod<typeof WS_METHODS.sourceControlPublishRepository>;
  };
  readonly shell: {
    readonly openInEditor: (input: {
      readonly cwd: Parameters<LocalApi["shell"]["openInEditor"]>[0];
      readonly editor: Parameters<LocalApi["shell"]["openInEditor"]>[1];
      readonly workspaceRoot?: Parameters<LocalApi["shell"]["openInEditor"]>[2];
    }) => ReturnType<LocalApi["shell"]["openInEditor"]>;
  };
  readonly vcs: {
    readonly pull: RpcUnaryMethod<typeof WS_METHODS.vcsPull>;
    readonly listStashes: RpcUnaryMethod<typeof WS_METHODS.vcsListStashes>;
    readonly createStash: RpcUnaryMethod<typeof WS_METHODS.vcsCreateStash>;
    readonly applyStash: RpcUnaryMethod<typeof WS_METHODS.vcsApplyStash>;
    readonly dropStash: RpcUnaryMethod<typeof WS_METHODS.vcsDropStash>;
    readonly refreshLocalStatus: RpcUnaryMethod<typeof WS_METHODS.vcsRefreshLocalStatus>;
    readonly refreshStatus: RpcUnaryMethod<typeof WS_METHODS.vcsRefreshStatus>;
    /** Only on servers reporting the `remoteStatusRefresh` capability. */
    readonly refreshRemoteStatus: RpcUnaryMethod<typeof WS_METHODS.vcsRefreshRemoteStatus>;
    readonly onStatus: (
      input: RpcInput<typeof WS_METHODS.subscribeVcsStatus>,
      listener: (status: VcsStatusResult) => void,
      options?: StreamSubscriptionOptions,
    ) => () => void;
    readonly listRefs: RpcUnaryMethod<typeof WS_METHODS.vcsListRefs>;
    readonly commitGraph: RpcUnaryMethod<typeof WS_METHODS.vcsCommitGraph>;
    readonly commitDetails: RpcUnaryMethod<typeof WS_METHODS.vcsCommitDetails>;
    readonly workingTreeDiff: RpcUnaryMethod<typeof WS_METHODS.vcsWorkingTreeDiff>;
    readonly discardChanges: RpcUnaryMethod<typeof WS_METHODS.vcsDiscardChanges>;
    readonly stageChanges: RpcUnaryMethod<typeof WS_METHODS.vcsStageChanges>;
    readonly unstageChanges: RpcUnaryMethod<typeof WS_METHODS.vcsUnstageChanges>;
    readonly createWorktree: RpcUnaryMethod<typeof WS_METHODS.vcsCreateWorktree>;
    readonly listWorktrees: RpcUnaryMethod<typeof WS_METHODS.vcsListWorktrees>;
    readonly removeWorktree: RpcUnaryMethod<typeof WS_METHODS.vcsRemoveWorktree>;
    readonly createRef: RpcUnaryMethod<typeof WS_METHODS.vcsCreateRef>;
    readonly createTag: RpcUnaryMethod<typeof WS_METHODS.vcsCreateTag>;
    readonly deleteBranch: RpcUnaryMethod<typeof WS_METHODS.vcsDeleteBranch>;
    readonly switchRef: RpcUnaryMethod<typeof WS_METHODS.vcsSwitchRef>;
    readonly mergeRef: RpcUnaryMethod<typeof WS_METHODS.vcsMergeRef>;
    readonly init: RpcUnaryMethod<typeof WS_METHODS.vcsInit>;
  };
  /**
   * Git-specific workflows. Local repository mechanics live under `vcs`.
   */
  readonly git: {
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitRunStackedActionOptions,
    ) => Promise<GitRunStackedActionResult>;
    readonly generateCommitMessage: (
      input: GitGenerateCommitMessageInput,
    ) => Promise<GitGenerateCommitMessageResult>;
    readonly resolvePullRequest: RpcUnaryMethod<typeof WS_METHODS.gitResolvePullRequest>;
    readonly preparePullRequestThread: RpcUnaryMethod<
      typeof WS_METHODS.gitPreparePullRequestThread
    >;
    readonly authRemediationPlan: RpcUnaryMethod<typeof WS_METHODS.gitAuthRemediationPlan>;
    readonly applyAuthRemediation: RpcUnaryMethod<typeof WS_METHODS.gitApplyAuthRemediation>;
  };
  /**
   * Pull requests read from the hosting provider through the server. One call
   * covers every eligible project in the environment.
   */
  readonly pullRequests: {
    readonly list: RpcUnaryMethod<typeof WS_METHODS.pullRequestsList>;
    readonly lookup: RpcUnaryMethod<typeof WS_METHODS.pullRequestsLookup>;
    readonly detail: RpcUnaryMethod<typeof WS_METHODS.pullRequestsDetail>;
    readonly activity: RpcUnaryMethod<typeof WS_METHODS.pullRequestsActivity>;
    readonly diff: RpcUnaryMethod<typeof WS_METHODS.pullRequestsDiff>;
    readonly comment: RpcUnaryMethod<typeof WS_METHODS.pullRequestsComment>;
    readonly runAction: RpcUnaryMethod<typeof WS_METHODS.pullRequestsRunAction>;
    readonly submitReview: RpcUnaryMethod<typeof WS_METHODS.pullRequestsSubmitReview>;
    readonly replyToThread: RpcUnaryMethod<typeof WS_METHODS.pullRequestsReplyToThread>;
    readonly setThreadResolution: RpcUnaryMethod<typeof WS_METHODS.pullRequestsSetThreadResolution>;
    readonly setReaction: RpcUnaryMethod<typeof WS_METHODS.pullRequestsSetReaction>;
    readonly update: RpcUnaryMethod<typeof WS_METHODS.pullRequestsUpdate>;
    readonly updateComment: RpcUnaryMethod<typeof WS_METHODS.pullRequestsUpdateComment>;
    readonly reviewerCandidates: RpcUnaryMethod<typeof WS_METHODS.pullRequestsReviewerCandidates>;
    readonly requestReviewers: RpcUnaryMethod<typeof WS_METHODS.pullRequestsRequestReviewers>;
    /** Only on servers reporting the `pullRequestObservations` capability. */
    readonly subscribeObservations: RpcStreamMethod<
      typeof WS_METHODS.pullRequestsSubscribeObservations
    >;
  };
  readonly server: {
    readonly getConfig: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetConfig>;
    /**
     * Refresh provider snapshots. Pass `{ instanceId }` to refresh a single
     * configured instance; pass no argument (or `{}`) to refresh all.
     */
    readonly refreshProviders: (
      input?: RpcInput<typeof WS_METHODS.serverRefreshProviders>,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.serverRefreshProviders>>;
    readonly startProviderReview: (
      input: ProviderStartReviewInput,
    ) => Promise<ProviderStartReviewResult>;
    readonly readSubagentTranscript: (
      input: ProviderSubagentTranscriptInput,
    ) => Promise<ProviderSubagentTranscriptResult>;
    readonly readWorkflowRunFile: RpcUnaryMethod<typeof WS_METHODS.serverReadWorkflowRunFile>;
    readonly readWorkflowAgentTranscript: RpcUnaryMethod<
      typeof WS_METHODS.serverReadWorkflowAgentTranscript
    >;
    readonly saveWorkflowCommand: RpcUnaryMethod<typeof WS_METHODS.serverSaveWorkflowCommand>;
    readonly sendSubagentInput: (
      input: ProviderSubagentInputRequest,
    ) => Promise<ProviderSubagentInputResult>;
    readonly listExternalProviderThreads: (
      input: ProviderExternalThreadListInput,
    ) => Promise<ProviderExternalThreadListResult>;
    readonly importExternalProviderThread: (
      input: ProviderExternalThreadImportInput,
    ) => Promise<ProviderExternalThreadImportResult>;
    readonly consumeProviderRateLimitResetCredit: RpcUnaryMethod<
      typeof WS_METHODS.serverConsumeProviderRateLimitResetCredit
    >;
    readonly setProviderDataSharing: RpcUnaryMethod<typeof WS_METHODS.serverSetProviderDataSharing>;
    readonly updateProvider: RpcUnaryMethod<typeof WS_METHODS.serverUpdateProvider>;
    readonly addProviderAccount: RpcUnaryMethod<typeof WS_METHODS.serverAddProviderAccount>;
    readonly removeProviderAccount: RpcUnaryMethod<typeof WS_METHODS.serverRemoveProviderAccount>;
    readonly listAcpRegistryAgents: RpcUnaryMethod<typeof WS_METHODS.serverListAcpRegistryAgents>;
    readonly addAcpRegistryAgent: RpcUnaryMethod<typeof WS_METHODS.serverAddAcpRegistryAgent>;
    readonly removeAcpRegistryAgent: RpcUnaryMethod<typeof WS_METHODS.serverRemoveAcpRegistryAgent>;
    readonly resolveProviderUpdateBlockers: RpcUnaryMethod<
      typeof WS_METHODS.serverResolveProviderUpdateBlockers
    >;
    readonly upsertKeybinding: RpcUnaryMethod<typeof WS_METHODS.serverUpsertKeybinding>;
    readonly removeKeybinding: RpcUnaryMethod<typeof WS_METHODS.serverRemoveKeybinding>;
    readonly getSettings: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetSettings>;
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.serverUpdateSettings>>;
    readonly discoverSourceControl: RpcUnaryNoArgMethod<
      typeof WS_METHODS.serverDiscoverSourceControl
    >;
    readonly updateSourceControlTool: RpcUnaryMethod<
      typeof WS_METHODS.serverUpdateSourceControlTool
    >;
    readonly getSourceControlSetup: RpcUnaryNoArgMethod<
      typeof WS_METHODS.serverGetSourceControlSetup
    >;
    readonly startGitHubAuth: RpcUnaryNoArgMethod<typeof WS_METHODS.serverStartGitHubAuth>;
    readonly cancelGitHubAuth: RpcUnaryNoArgMethod<typeof WS_METHODS.serverCancelGitHubAuth>;
    readonly getTraceDiagnostics: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetTraceDiagnostics>;
    readonly getProcessDiagnostics: RpcUnaryNoArgMethod<
      typeof WS_METHODS.serverGetProcessDiagnostics
    >;
    readonly getProcessResourceHistory: RpcUnaryMethod<
      typeof WS_METHODS.serverGetProcessResourceHistory
    >;
    readonly signalProcess: RpcUnaryMethod<typeof WS_METHODS.serverSignalProcess>;
    readonly resolveBackgroundRuns: RpcUnaryMethod<typeof WS_METHODS.serverResolveBackgroundRuns>;
    readonly readBackgroundRunOutput: RpcUnaryMethod<
      typeof WS_METHODS.serverReadBackgroundRunOutput
    >;
    readonly readCommandOutput: RpcUnaryMethod<typeof WS_METHODS.serverReadCommandOutput>;
    readonly loadMcpApp: RpcUnaryMethod<typeof WS_METHODS.serverLoadMcpApp>;
    readonly callMcpAppTool: RpcUnaryMethod<typeof WS_METHODS.serverCallMcpAppTool>;
    readonly stopBackgroundRun: RpcUnaryMethod<typeof WS_METHODS.serverStopBackgroundRun>;
    readonly getProviderExtensions: RpcUnaryMethod<typeof WS_METHODS.serverGetProviderExtensions>;
    readonly startProviderExtensionMcpOAuth: RpcUnaryMethod<
      typeof WS_METHODS.serverStartProviderExtensionMcpOAuth
    >;
    readonly getProviderExtensionOperationStatus: RpcUnaryMethod<
      typeof WS_METHODS.serverGetProviderExtensionOperationStatus
    >;
    readonly reloadProviderExtensionMcpServers: RpcUnaryMethod<
      typeof WS_METHODS.serverReloadProviderExtensionMcpServers
    >;
    readonly setProviderExtensionSkillEnabled: RpcUnaryMethod<
      typeof WS_METHODS.serverSetProviderExtensionSkillEnabled
    >;
    readonly readProviderExtensionSkill: RpcUnaryMethod<
      typeof WS_METHODS.serverReadProviderExtensionSkill
    >;
    readonly createProviderExtensionSkill: RpcUnaryMethod<
      typeof WS_METHODS.serverCreateProviderExtensionSkill
    >;
    readonly deleteProviderExtensionSkill: RpcUnaryMethod<
      typeof WS_METHODS.serverDeleteProviderExtensionSkill
    >;
    readonly readProviderExtensionPlugin: RpcUnaryMethod<
      typeof WS_METHODS.serverReadProviderExtensionPlugin
    >;
    readonly installProviderExtensionPlugin: RpcUnaryMethod<
      typeof WS_METHODS.serverInstallProviderExtensionPlugin
    >;
    readonly uninstallProviderExtensionPlugin: RpcUnaryMethod<
      typeof WS_METHODS.serverUninstallProviderExtensionPlugin
    >;
    readonly setProviderExtensionPluginEnabled: RpcUnaryMethod<
      typeof WS_METHODS.serverSetProviderExtensionPluginEnabled
    >;
    readonly updateProviderExtensionPlugin: RpcUnaryMethod<
      typeof WS_METHODS.serverUpdateProviderExtensionPlugin
    >;
    readonly refreshProviderExtensionPluginMarketplaces: RpcUnaryMethod<
      typeof WS_METHODS.serverRefreshProviderExtensionPluginMarketplaces
    >;
    readonly addProviderExtensionMarketplace: RpcUnaryMethod<
      typeof WS_METHODS.serverAddProviderExtensionMarketplace
    >;
    readonly removeProviderExtensionMarketplace: RpcUnaryMethod<
      typeof WS_METHODS.serverRemoveProviderExtensionMarketplace
    >;
    readonly callProviderExtensionMcpTool: RpcUnaryMethod<
      typeof WS_METHODS.serverCallProviderExtensionMcpTool
    >;
    readonly readProviderExtensionMcpResource: RpcUnaryMethod<
      typeof WS_METHODS.serverReadProviderExtensionMcpResource
    >;
    readonly getProviderInstructionFiles: RpcUnaryMethod<
      typeof WS_METHODS.serverGetProviderInstructionFiles
    >;
    readonly writeProviderInstructionFile: RpcUnaryMethod<
      typeof WS_METHODS.serverWriteProviderInstructionFile
    >;
    readonly subscribeConfig: RpcStreamMethod<typeof WS_METHODS.subscribeServerConfig>;
    readonly subscribeLifecycle: RpcStreamMethod<typeof WS_METHODS.subscribeServerLifecycle>;
    /** Only on servers reporting the `stallReports` capability. */
    readonly subscribeStalls: RpcStreamMethod<typeof WS_METHODS.subscribeServerStalls>;
    readonly subscribeAuthAccess: RpcStreamMethod<typeof WS_METHODS.subscribeAuthAccess>;
  };
  /** "Connect a device". Host methods are owner-only on the server. */
  readonly relay: {
    readonly subscribeAccess: RpcStreamMethod<typeof WS_METHODS.subscribeRelayAccess>;
    readonly createInvite: RpcUnaryNoArgMethod<typeof WS_METHODS.relayCreateInvite>;
    readonly cancelInvite: RpcUnaryMethod<typeof WS_METHODS.relayCancelInvite>;
    readonly respondToJoinRequest: RpcUnaryMethod<typeof WS_METHODS.relayRespondToJoinRequest>;
    readonly submitJoin: RpcUnaryMethod<typeof WS_METHODS.relaySubmitJoin>;
    readonly directRoutes: RpcUnaryNoArgMethod<typeof WS_METHODS.relayDirectRoutes>;
  };
  /** Phone alerts (docs/design/push-alerts.md): this phone's registration with the computer. */
  readonly push: {
    readonly register: RpcUnaryMethod<typeof WS_METHODS.pushRegister>;
    readonly unregister: RpcUnaryNoArgMethod<typeof WS_METHODS.pushUnregister>;
    readonly sendTest: RpcUnaryNoArgMethod<typeof WS_METHODS.pushSendTest>;
  };
  /** The thread this connection shows, so the computer keeps it quiet. */
  readonly presence: {
    readonly setViewing: RpcUnaryMethod<typeof WS_METHODS.presenceSetViewing>;
  };
  /** This computer's scheduled tasks (docs/design/fleet.md, Part 6). */
  readonly scheduledTasks: {
    readonly subscribe: RpcStreamMethod<typeof WS_METHODS.scheduledTasksSubscribe>;
    readonly listRuns: RpcUnaryMethod<typeof WS_METHODS.scheduledTasksListRuns>;
    readonly create: RpcUnaryMethod<typeof WS_METHODS.scheduledTasksCreate>;
    readonly update: RpcUnaryMethod<typeof WS_METHODS.scheduledTasksUpdate>;
    readonly remove: RpcUnaryMethod<typeof WS_METHODS.scheduledTasksDelete>;
    readonly runNow: RpcUnaryMethod<typeof WS_METHODS.scheduledTasksRunNow>;
    readonly respondRequest: RpcUnaryMethod<typeof WS_METHODS.scheduledTasksRespondRequest>;
    /** Event tasks (docs/design/event-tasks.md), on servers reporting `eventTasks`. */
    readonly webhookAddress: RpcUnaryMethod<typeof WS_METHODS.scheduledTasksWebhookAddress>;
    readonly rotateWebhookAddress: RpcUnaryMethod<
      typeof WS_METHODS.scheduledTasksRotateWebhookAddress
    >;
    readonly setWebhookSigningSecret: RpcUnaryMethod<
      typeof WS_METHODS.scheduledTasksSetWebhookSigningSecret
    >;
    readonly revealWebhookSigningSecret: RpcUnaryMethod<
      typeof WS_METHODS.scheduledTasksRevealWebhookSigningSecret
    >;
    readonly gitHubContext: RpcUnaryMethod<typeof WS_METHODS.scheduledTasksGitHubContext>;
    readonly connectGitHub: RpcUnaryMethod<typeof WS_METHODS.scheduledTasksConnectGitHub>;
    readonly disconnectGitHub: RpcUnaryMethod<typeof WS_METHODS.scheduledTasksDisconnectGitHub>;
    readonly listWebhookEvents: RpcUnaryMethod<typeof WS_METHODS.scheduledTasksListWebhookEvents>;
    readonly webhookEvent: RpcUnaryMethod<typeof WS_METHODS.scheduledTasksWebhookEvent>;
    readonly testWebhook: RpcUnaryMethod<typeof WS_METHODS.scheduledTasksTestWebhook>;
    readonly runWithWebhookEvent: RpcUnaryMethod<
      typeof WS_METHODS.scheduledTasksRunWithWebhookEvent
    >;
    readonly dismissWebhookAddressChange: RpcUnaryMethod<
      typeof WS_METHODS.scheduledTasksDismissWebhookAddressChange
    >;
  };
  /**
   * Agents outside Threadlines (docs/design/outside-agents.md): owner only,
   * on servers whose descriptor reports `outsideAgents`.
   */
  readonly outsideAgents: {
    readonly subscribe: RpcStreamMethod<typeof WS_METHODS.outsideAgentsSubscribe>;
    readonly approve: RpcUnaryMethod<typeof WS_METHODS.outsideAgentsApprove>;
    readonly deny: RpcUnaryMethod<typeof WS_METHODS.outsideAgentsDeny>;
    readonly denyAll: RpcUnaryNoArgMethod<typeof WS_METHODS.outsideAgentsDenyAll>;
    readonly resumeRequests: RpcUnaryNoArgMethod<typeof WS_METHODS.outsideAgentsResumeRequests>;
    readonly update: RpcUnaryMethod<typeof WS_METHODS.outsideAgentsUpdate>;
    readonly remove: RpcUnaryMethod<typeof WS_METHODS.outsideAgentsRemove>;
    /** Assistants (docs/design/assistants.md): a sign-in code to show, and a key-signed connection. */
    readonly assistantCode: RpcUnaryNoArgMethod<typeof WS_METHODS.outsideAgentsAssistantCode>;
    readonly assistantCodeCancel: RpcUnaryNoArgMethod<
      typeof WS_METHODS.outsideAgentsAssistantCodeCancel
    >;
    readonly createKey: RpcUnaryMethod<typeof WS_METHODS.outsideAgentsCreateKey>;
  };
  /**
   * Computer links (docs/design/fleet.md): owner and client sessions alike,
   * on servers whose descriptor reports `computerLinks`.
   */
  readonly links: {
    readonly subscribe: RpcStreamMethod<typeof WS_METHODS.linksSubscribe>;
    readonly createInvite: RpcUnaryMethod<typeof WS_METHODS.linksCreateInvite>;
    readonly accept: RpcUnaryMethod<typeof WS_METHODS.linksAccept>;
    readonly setAccess: RpcUnaryMethod<typeof WS_METHODS.linksSetAccess>;
    readonly remove: RpcUnaryMethod<typeof WS_METHODS.linksRemove>;
    readonly respondRequest: RpcUnaryMethod<typeof WS_METHODS.linksRespondRequest>;
  };
  /**
   * Moving a thread to a linked computer (docs/design/fleet.md, Part 3), on
   * servers whose descriptor reports `threadMove`.
   */
  readonly moves: {
    readonly preview: RpcUnaryMethod<typeof WS_METHODS.movesPreview>;
    readonly start: RpcUnaryMethod<typeof WS_METHODS.movesStart>;
    readonly cancel: RpcUnaryMethod<typeof WS_METHODS.movesCancel>;
  };
  /**
   * Setting up a project on another computer (docs/design/fleet.md, Part 8),
   * on servers whose descriptor reports `projectSetup`: `source` and
   * `readFiles` on the computer that has the project, the rest on the one
   * that gets a copy.
   */
  readonly projectSetups: {
    readonly source: RpcUnaryMethod<typeof WS_METHODS.projectSetupsSource>;
    readonly readFiles: RpcUnaryMethod<typeof WS_METHODS.projectSetupsReadFiles>;
    readonly inspectDestination: RpcUnaryMethod<typeof WS_METHODS.projectSetupsInspectDestination>;
    readonly start: RpcUnaryMethod<typeof WS_METHODS.projectSetupsStart>;
    readonly cancel: RpcUnaryMethod<typeof WS_METHODS.projectSetupsCancel>;
    readonly dismiss: RpcUnaryMethod<typeof WS_METHODS.projectSetupsDismiss>;
    readonly subscribe: RpcStreamMethod<typeof WS_METHODS.projectSetupsSubscribe>;
  };
  readonly orchestration: {
    readonly dispatchCommand: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.dispatchCommand>;
    readonly warmUpTurn: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.warmUpTurn>;
    readonly getTurnDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getTurnDiff>;
    readonly getFullThreadDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff>;
    readonly getRevertPlan: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getRevertPlan>;
    readonly searchThreads: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.searchThreads>;
    readonly getTurnActivities: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getTurnActivities>;
    readonly getArchivedShellSnapshot: RpcUnaryNoArgMethod<
      typeof ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot
    >;
    readonly subscribeShell: RpcStreamMethod<typeof ORCHESTRATION_WS_METHODS.subscribeShell>;
    readonly subscribeThread: RpcInputStreamMethod<typeof ORCHESTRATION_WS_METHODS.subscribeThread>;
  };
}

const DISPATCH_ATTEMPT_TIMEOUT_BASE_MS = 25_000;
// Image attachments travel inline as data URLs inside the command payload,
// so a turn.start can be tens of megabytes on a slow mobile uplink. Scale
// the per-attempt timeout with payload size so a legitimately slow upload
// is not killed and pointlessly re-sent from scratch.
const DISPATCH_ATTEMPT_TIMEOUT_PER_UPLOAD_MB_MS = 20_000;
const DISPATCH_ATTEMPT_TIMEOUT_MAX_MS = 180_000;

export function estimateCommandUploadChars(command: unknown): number {
  if (typeof command !== "object" || command === null || !("message" in command)) {
    return 0;
  }
  const message = (command as { readonly message?: unknown }).message;
  if (typeof message !== "object" || message === null || !("attachments" in message)) {
    return 0;
  }
  const attachments = (message as { readonly attachments?: unknown }).attachments;
  if (!Array.isArray(attachments)) {
    return 0;
  }
  let totalChars = 0;
  for (const attachment of attachments) {
    if (typeof attachment !== "object" || attachment === null || !("dataUrl" in attachment)) {
      continue;
    }
    const dataUrl = (attachment as { readonly dataUrl?: unknown }).dataUrl;
    if (typeof dataUrl === "string") {
      totalChars += dataUrl.length;
    }
  }
  return totalChars;
}

export function dispatchCommandRetryOptions(command: unknown): {
  readonly label: string;
  readonly attemptTimeoutMs: number;
  readonly totalBudgetMs: number;
} {
  const uploadChars = estimateCommandUploadChars(command);
  const attemptTimeoutMs = Math.min(
    DISPATCH_ATTEMPT_TIMEOUT_MAX_MS,
    DISPATCH_ATTEMPT_TIMEOUT_BASE_MS +
      Math.ceil(uploadChars / 1_000_000) * DISPATCH_ATTEMPT_TIMEOUT_PER_UPLOAD_MB_MS,
  );
  return {
    label: ORCHESTRATION_WS_METHODS.dispatchCommand,
    attemptTimeoutMs,
    totalBudgetMs: attemptTimeoutMs * 3 + 15_000,
  };
}

function isRealtimeStartCommand(command: unknown): boolean {
  return (
    typeof command === "object" &&
    command !== null &&
    "type" in command &&
    command.type === "thread.realtime.start"
  );
}

export function createWsRpcClient(transport: WsTransport): WsRpcClient {
  return {
    dispose: () => transport.dispose(),
    reconnect: async () => {
      // Another computer's reconnect leaves this computer's backoff alone.
      if (transport.reportsAppConnection !== false) resetWsReconnectBackoff();
      await transport.reconnect();
    },
    isHeartbeatFresh: () => transport.isHeartbeatFresh(),
    terminal: {
      open: (input) => transport.request((client) => client[WS_METHODS.terminalOpen](input)),
      write: (input) => transport.request((client) => client[WS_METHODS.terminalWrite](input)),
      resize: (input) => transport.request((client) => client[WS_METHODS.terminalResize](input)),
      clear: (input) => transport.request((client) => client[WS_METHODS.terminalClear](input)),
      restart: (input) => transport.request((client) => client[WS_METHODS.terminalRestart](input)),
      close: (input) => transport.request((client) => client[WS_METHODS.terminalClose](input)),
      resolveInterrupted: (input) =>
        transport.request((client) => client[WS_METHODS.terminalResolveInterrupted](input)),
      resolvePortInUse: (input) =>
        transport.request((client) => client[WS_METHODS.terminalResolvePortInUse](input)),
      onEvent: (input, listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeTerminalEvents](input),
          listener,
          {
            ...options,
            tag: WS_METHODS.subscribeTerminalEvents,
          },
        ),
    },
    providerAuth: {
      start: (input) => transport.request((client) => client[WS_METHODS.providerAuthStart](input)),
      write: (input) => transport.request((client) => client[WS_METHODS.providerAuthWrite](input)),
      resize: (input) =>
        transport.request((client) => client[WS_METHODS.providerAuthResize](input)),
      stop: (input) => transport.request((client) => client[WS_METHODS.providerAuthStop](input)),
      respond: (input) =>
        transport.request((client) => client[WS_METHODS.providerAuthRespond](input)),
      subscribe: (input, listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.providerAuthSubscribe](input), listener, {
          tag: WS_METHODS.providerAuthSubscribe,
          ...options,
        }),
    },
    realtime: {
      appendAudio: (input) =>
        transport.request((client) => client[WS_METHODS.realtimeAppendAudio](input)),
      subscribeAudio: (input, listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.realtimeSubscribeAudio](input),
          listener,
          {
            tag: WS_METHODS.realtimeSubscribeAudio,
            resubscribe: false,
            ...(options?.onComplete ? { onComplete: options.onComplete } : {}),
          },
        ),
    },
    dictation: {
      // Status drives whether the mic records or opens the setup popover, so
      // it has to survive a reconnect without the composer being remounted.
      subscribeStatus: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.dictationSubscribeStatus]({}), listener, {
          ...options,
          tag: WS_METHODS.dictationSubscribeStatus,
          resubscribe: true,
        }),
      downloadModel: (input) =>
        transport.request((client) => client[WS_METHODS.dictationDownloadModel](input)),
      cancelDownload: (input) =>
        transport.request((client) => client[WS_METHODS.dictationCancelDownload](input)),
      removeModel: (input) =>
        transport.request((client) => client[WS_METHODS.dictationRemoveModel](input)),
      warmUp: () => transport.request((client) => client[WS_METHODS.dictationWarmUp]({})),
      transcribe: (input) =>
        transport.request((client) => client[WS_METHODS.dictationTranscribe](input)),
    },
    previewAutomation: {
      connect: (input, listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.previewAutomationConnect](input),
          listener,
          {
            tag: WS_METHODS.previewAutomationConnect,
            ...options,
          },
        ),
      respond: (input) =>
        transport.request((client) => client[WS_METHODS.previewAutomationRespond](input)),
      progress: (input) =>
        transport.request((client) => client[WS_METHODS.previewAutomationProgress](input)),
      connectClient: (input, listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.previewAutomationConnectClient](input),
          listener,
          {
            tag: WS_METHODS.previewAutomationConnectClient,
            ...options,
          },
        ),
      claim: (input) =>
        transport.request((client) => client[WS_METHODS.previewAutomationClaim](input)),
      active: (input) =>
        transport.request((client) => client[WS_METHODS.previewAutomationActive](input)),
    },
    previewLoopback: {
      // A byte stream cannot pick up where it left off: when the connection
      // drops, the tunnel ends and the page sees its connection close.
      open: (input, listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.previewTunnelOpen](input), listener, {
          tag: WS_METHODS.previewTunnelOpen,
          resubscribe: false,
          ...(options?.onComplete ? { onComplete: options.onComplete } : {}),
        }),
      write: (input) => transport.request((client) => client[WS_METHODS.previewTunnelWrite](input)),
      credit: (input) =>
        transport.request((client) => client[WS_METHODS.previewTunnelCredit](input)),
      localServers: () => transport.request((client) => client[WS_METHODS.previewLocalServers]({})),
    },
    projects: {
      searchEntries: (input) =>
        transport.request((client) => client[WS_METHODS.projectsSearchEntries](input)),
      writeFile: (input) =>
        transport.request((client) => client[WS_METHODS.projectsWriteFile](input)),
      listEntries: (input) =>
        transport.request((client) => client[WS_METHODS.projectsListEntries](input)),
      readFile: (input) =>
        transport.request((client) => client[WS_METHODS.projectsReadFile](input)),
      favicon: (input) => transport.request((client) => client[WS_METHODS.projectsFavicon](input)),
    },
    attachments: {
      // Pure read, so retrying across relay churn is safe; phones fetch
      // previews this way and their sockets drop constantly.
      read: (input) =>
        transport.requestWithReconnectRetry((client) => client[WS_METHODS.attachmentsRead](input), {
          label: WS_METHODS.attachmentsRead,
        }),
    },
    visualizations: {
      read: (input) =>
        transport.requestWithReconnectRetry(
          (client) => client[WS_METHODS.visualizationsRead](input),
          { label: WS_METHODS.visualizationsRead },
        ),
    },
    pages: {
      read: (input) =>
        transport.requestWithReconnectRetry((client) => client[WS_METHODS.pagesRead](input), {
          label: WS_METHODS.pagesRead,
        }),
    },
    // Not retried on reconnect: a start opens a terminal, a send sends a message.
    commandRuns: {
      start: (input) => transport.request((client) => client[WS_METHODS.commandRunsStart](input)),
      sendOutput: (input) =>
        transport.request((client) => client[WS_METHODS.commandRunsSendOutput](input)),
    },
    filesystem: {
      browse: (input) => transport.request((client) => client[WS_METHODS.filesystemBrowse](input)),
    },
    usage: {
      // Pure read that lands in the busiest seconds after launch, when a missed
      // heartbeat drops the socket; a plain request would just fail there. A
      // cold transcript scan can take a minute on a slow disk, so one attempt
      // gets two. An interrupted scan keeps the files it already parsed.
      summary: (input) =>
        transport.requestWithReconnectRetry((client) => client[WS_METHODS.usageSummary](input), {
          label: WS_METHODS.usageSummary,
          attemptTimeoutMs: 120_000,
          totalBudgetMs: 180_000,
        }),
      // Pure read too. The server asks Claude, which reads a week of
      // transcripts; the server gives it a minute and a half.
      breakdowns: () =>
        transport.requestWithReconnectRetry((client) => client[WS_METHODS.usageBreakdowns]({}), {
          label: WS_METHODS.usageBreakdowns,
          attemptTimeoutMs: 120_000,
          totalBudgetMs: 180_000,
        }),
    },
    sourceControl: {
      lookupRepository: (input) =>
        transport.request((client) => client[WS_METHODS.sourceControlLookupRepository](input)),
      listRepositories: (input) =>
        transport.request((client) => client[WS_METHODS.sourceControlListRepositories](input)),
      cloneRepository: (input) =>
        transport.request((client) => client[WS_METHODS.sourceControlCloneRepository](input)),
      publishRepository: (input) =>
        transport.request((client) => client[WS_METHODS.sourceControlPublishRepository](input)),
    },
    shell: {
      openInEditor: (input) =>
        transport.request((client) => client[WS_METHODS.shellOpenInEditor](input)),
    },
    vcs: {
      pull: (input) => transport.request((client) => client[WS_METHODS.vcsPull](input)),
      listStashes: (input) =>
        transport.request((client) => client[WS_METHODS.vcsListStashes](input)),
      createStash: (input) =>
        transport.request((client) => client[WS_METHODS.vcsCreateStash](input)),
      applyStash: (input) => transport.request((client) => client[WS_METHODS.vcsApplyStash](input)),
      dropStash: (input) => transport.request((client) => client[WS_METHODS.vcsDropStash](input)),
      refreshLocalStatus: (input) =>
        transport.request((client) => client[WS_METHODS.vcsRefreshLocalStatus](input)),
      refreshStatus: (input) =>
        transport.request((client) => client[WS_METHODS.vcsRefreshStatus](input)),
      refreshRemoteStatus: (input) =>
        transport.request((client) => client[WS_METHODS.vcsRefreshRemoteStatus](input)),
      onStatus: (input, listener, options) => {
        let current: VcsStatusResult | null = null;
        return transport.subscribe(
          (client) => client[WS_METHODS.subscribeVcsStatus](input),
          (event: VcsStatusStreamEvent) => {
            current = applyGitStatusStreamEvent(current, event);
            listener(current);
          },
          { ...options, tag: WS_METHODS.subscribeVcsStatus },
        );
      },
      listRefs: (input) => transport.request((client) => client[WS_METHODS.vcsListRefs](input)),
      commitGraph: (input) =>
        transport.request((client) => client[WS_METHODS.vcsCommitGraph](input)),
      commitDetails: (input) =>
        transport.request((client) => client[WS_METHODS.vcsCommitDetails](input)),
      workingTreeDiff: (input) =>
        transport.request((client) => client[WS_METHODS.vcsWorkingTreeDiff](input)),
      discardChanges: (input) =>
        transport.request((client) => client[WS_METHODS.vcsDiscardChanges](input)),
      stageChanges: (input) =>
        transport.request((client) => client[WS_METHODS.vcsStageChanges](input)),
      unstageChanges: (input) =>
        transport.request((client) => client[WS_METHODS.vcsUnstageChanges](input)),
      createWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.vcsCreateWorktree](input)),
      listWorktrees: (input) =>
        transport.request((client) => client[WS_METHODS.vcsListWorktrees](input)),
      removeWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.vcsRemoveWorktree](input)),
      createRef: (input) => transport.request((client) => client[WS_METHODS.vcsCreateRef](input)),
      createTag: (input) => transport.request((client) => client[WS_METHODS.vcsCreateTag](input)),
      deleteBranch: (input) =>
        transport.request((client) => client[WS_METHODS.vcsDeleteBranch](input)),
      switchRef: (input) => transport.request((client) => client[WS_METHODS.vcsSwitchRef](input)),
      mergeRef: (input) => transport.request((client) => client[WS_METHODS.vcsMergeRef](input)),
      init: (input) => transport.request((client) => client[WS_METHODS.vcsInit](input)),
    },
    git: {
      runStackedAction: async (input, options) => {
        let result: GitRunStackedActionResult | null = null;

        await transport.requestStream(
          (client) => client[WS_METHODS.gitRunStackedAction](input),
          (event) => {
            options?.onProgress?.(event);
            if (event.kind === "action_finished") {
              result = event.result;
            }
          },
        );

        if (result) {
          return result;
        }

        throw new Error("Git action stream completed without a final result.");
      },
      generateCommitMessage: (input) =>
        transport.request((client) => client[WS_METHODS.gitGenerateCommitMessage](input)),
      resolvePullRequest: (input) =>
        transport.request((client) => client[WS_METHODS.gitResolvePullRequest](input)),
      preparePullRequestThread: (input) =>
        transport.request((client) => client[WS_METHODS.gitPreparePullRequestThread](input)),
      authRemediationPlan: (input) =>
        transport.request((client) => client[WS_METHODS.gitAuthRemediationPlan](input)),
      applyAuthRemediation: (input) =>
        transport.request((client) => client[WS_METHODS.gitApplyAuthRemediation](input)),
    },
    pullRequests: {
      list: (input) => transport.request((client) => client[WS_METHODS.pullRequestsList](input)),
      lookup: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsLookup](input)),
      subscribeObservations: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.pullRequestsSubscribeObservations]({}),
          listener,
          { ...options, tag: WS_METHODS.pullRequestsSubscribeObservations },
        ),
      detail: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsDetail](input)),
      activity: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsActivity](input)),
      diff: (input) => transport.request((client) => client[WS_METHODS.pullRequestsDiff](input)),
      comment: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsComment](input)),
      runAction: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsRunAction](input)),
      submitReview: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsSubmitReview](input)),
      replyToThread: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsReplyToThread](input)),
      setThreadResolution: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsSetThreadResolution](input)),
      setReaction: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsSetReaction](input)),
      update: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsUpdate](input)),
      updateComment: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsUpdateComment](input)),
      reviewerCandidates: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsReviewerCandidates](input)),
      requestReviewers: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsRequestReviewers](input)),
    },
    server: {
      // Pure read, and the only thing standing between adding a computer and a
      // closed dialog. A plain request is pinned to the transport session it
      // started on, so a socket drop or session swap mid-pairing left it
      // pending forever and the dialog stuck on "Adding...".
      getConfig: () =>
        transport.requestWithReconnectRetry((client) => client[WS_METHODS.serverGetConfig]({}), {
          label: WS_METHODS.serverGetConfig,
          // Tighter than the shared default: this is a small read that gates a
          // modal, so failing loudly beats spinning.
          attemptTimeoutMs: 10_000,
          totalBudgetMs: 30_000,
        }),
      refreshProviders: (input) =>
        transport.request((client) => client[WS_METHODS.serverRefreshProviders](input ?? {})),
      startProviderReview: (input) =>
        transport.request((client) => client[WS_METHODS.serverStartProviderReview](input)),
      readSubagentTranscript: (input) =>
        transport.request((client) => client[WS_METHODS.serverReadSubagentTranscript](input)),
      readWorkflowRunFile: (input) =>
        transport.request((client) => client[WS_METHODS.serverReadWorkflowRunFile](input)),
      readWorkflowAgentTranscript: (input) =>
        transport.request((client) => client[WS_METHODS.serverReadWorkflowAgentTranscript](input)),
      saveWorkflowCommand: (input) =>
        transport.request((client) => client[WS_METHODS.serverSaveWorkflowCommand](input)),
      sendSubagentInput: (input) =>
        transport.request((client) => client[WS_METHODS.serverSendSubagentInput](input)),
      listExternalProviderThreads: (input) =>
        transport.request((client) => client[WS_METHODS.serverListExternalProviderThreads](input)),
      importExternalProviderThread: (input) =>
        transport.request((client) => client[WS_METHODS.serverImportExternalProviderThread](input)),
      consumeProviderRateLimitResetCredit: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverConsumeProviderRateLimitResetCredit](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      setProviderDataSharing: (input) =>
        transport.request((client) => client[WS_METHODS.serverSetProviderDataSharing](input)),
      updateProvider: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpdateProvider](input)),
      addProviderAccount: (input) =>
        transport.request((client) => client[WS_METHODS.serverAddProviderAccount](input)),
      removeProviderAccount: (input) =>
        transport.request((client) => client[WS_METHODS.serverRemoveProviderAccount](input)),
      listAcpRegistryAgents: (input) =>
        transport.request((client) => client[WS_METHODS.serverListAcpRegistryAgents](input)),
      addAcpRegistryAgent: (input) =>
        transport.request((client) => client[WS_METHODS.serverAddAcpRegistryAgent](input)),
      removeAcpRegistryAgent: (input) =>
        transport.request((client) => client[WS_METHODS.serverRemoveAcpRegistryAgent](input)),
      resolveProviderUpdateBlockers: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverResolveProviderUpdateBlockers](input),
        ),
      upsertKeybinding: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpsertKeybinding](input)),
      removeKeybinding: (input) =>
        transport.request((client) => client[WS_METHODS.serverRemoveKeybinding](input)),
      getSettings: () => transport.request((client) => client[WS_METHODS.serverGetSettings]({})),
      updateSettings: (patch) =>
        transport.request((client) => client[WS_METHODS.serverUpdateSettings]({ patch })),
      discoverSourceControl: () =>
        transport.request((client) => client[WS_METHODS.serverDiscoverSourceControl]({})),
      updateSourceControlTool: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpdateSourceControlTool](input)),
      getSourceControlSetup: () =>
        transport.request((client) => client[WS_METHODS.serverGetSourceControlSetup]({})),
      startGitHubAuth: () =>
        transport.request((client) => client[WS_METHODS.serverStartGitHubAuth]({})),
      cancelGitHubAuth: () =>
        transport.request((client) => client[WS_METHODS.serverCancelGitHubAuth]({})),
      getTraceDiagnostics: () =>
        transport.request((client) =>
          client[WS_METHODS.serverGetTraceDiagnostics]({}).pipe(Effect.withTracerEnabled(false)),
        ),
      getProcessDiagnostics: () =>
        transport.request((client) =>
          client[WS_METHODS.serverGetProcessDiagnostics]({}).pipe(Effect.withTracerEnabled(false)),
        ),
      getProcessResourceHistory: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverGetProcessResourceHistory](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      signalProcess: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverSignalProcess](input).pipe(Effect.withTracerEnabled(false)),
        ),
      resolveBackgroundRuns: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverResolveBackgroundRuns](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      stopBackgroundRun: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverStopBackgroundRun](input).pipe(Effect.withTracerEnabled(false)),
        ),
      // Polled while a row is on screen: a read that hangs is cancelled
      // rather than left waiting, so polls never pile up behind it.
      readBackgroundRunOutput: (input) =>
        transport.request(
          (client) =>
            client[WS_METHODS.serverReadBackgroundRunOutput](input).pipe(
              Effect.withTracerEnabled(false),
            ),
          { timeout: OUTPUT_READ_TIMEOUT },
        ),
      readCommandOutput: (input) =>
        transport.request(
          (client) =>
            client[WS_METHODS.serverReadCommandOutput](input).pipe(Effect.withTracerEnabled(false)),
          { timeout: OUTPUT_READ_TIMEOUT },
        ),
      // A card's view may load through an agent session started for it, and a
      // tool call an app makes runs as long as the tool does.
      loadMcpApp: (input) =>
        transport.request((client) => client[WS_METHODS.serverLoadMcpApp](input), {
          timeout: MCP_APP_REQUEST_TIMEOUT,
        }),
      callMcpAppTool: (input) =>
        transport.request((client) => client[WS_METHODS.serverCallMcpAppTool](input), {
          timeout: MCP_APP_REQUEST_TIMEOUT,
        }),
      // Pure read. A plain request lost to a dropped socket left the plugins page empty with no
      // error until it remounted. With MCP and apps included the server may legitimately take
      // most of a minute, so one attempt gets that long.
      getProviderExtensions: (input) =>
        transport.requestWithReconnectRetry(
          (client) =>
            client[WS_METHODS.serverGetProviderExtensions](input).pipe(
              Effect.withTracerEnabled(false),
            ),
          {
            label: WS_METHODS.serverGetProviderExtensions,
            attemptTimeoutMs: 60_000,
            totalBudgetMs: 120_000,
          },
        ),
      startProviderExtensionMcpOAuth: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverStartProviderExtensionMcpOAuth](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      getProviderExtensionOperationStatus: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverGetProviderExtensionOperationStatus](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      reloadProviderExtensionMcpServers: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverReloadProviderExtensionMcpServers](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      setProviderExtensionSkillEnabled: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverSetProviderExtensionSkillEnabled](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      readProviderExtensionSkill: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverReadProviderExtensionSkill](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      createProviderExtensionSkill: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverCreateProviderExtensionSkill](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      deleteProviderExtensionSkill: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverDeleteProviderExtensionSkill](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      readProviderExtensionPlugin: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverReadProviderExtensionPlugin](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      installProviderExtensionPlugin: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverInstallProviderExtensionPlugin](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      uninstallProviderExtensionPlugin: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverUninstallProviderExtensionPlugin](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      setProviderExtensionPluginEnabled: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverSetProviderExtensionPluginEnabled](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      updateProviderExtensionPlugin: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverUpdateProviderExtensionPlugin](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      refreshProviderExtensionPluginMarketplaces: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverRefreshProviderExtensionPluginMarketplaces](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      addProviderExtensionMarketplace: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverAddProviderExtensionMarketplace](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      removeProviderExtensionMarketplace: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverRemoveProviderExtensionMarketplace](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      callProviderExtensionMcpTool: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverCallProviderExtensionMcpTool](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      readProviderExtensionMcpResource: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverReadProviderExtensionMcpResource](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      getProviderInstructionFiles: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverGetProviderInstructionFiles](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      writeProviderInstructionFile: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverWriteProviderInstructionFile](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      subscribeConfig: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeServerConfig]({}), listener, {
          ...options,
          tag: WS_METHODS.subscribeServerConfig,
        }),
      subscribeLifecycle: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeServerLifecycle]({}), listener, {
          ...options,
          tag: WS_METHODS.subscribeServerLifecycle,
        }),
      subscribeStalls: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeServerStalls]({}), listener, {
          ...options,
          tag: WS_METHODS.subscribeServerStalls,
        }),
      subscribeAuthAccess: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeAuthAccess]({}), listener, {
          ...options,
          tag: WS_METHODS.subscribeAuthAccess,
        }),
    },
    relay: {
      subscribeAccess: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeRelayAccess]({}), listener, {
          ...options,
          tag: WS_METHODS.subscribeRelayAccess,
        }),
      createInvite: () => transport.request((client) => client[WS_METHODS.relayCreateInvite]({})),
      cancelInvite: (input) =>
        transport.request((client) => client[WS_METHODS.relayCancelInvite](input)),
      respondToJoinRequest: (input) =>
        transport.request((client) => client[WS_METHODS.relayRespondToJoinRequest](input)),
      submitJoin: (input) =>
        transport.request((client) => client[WS_METHODS.relaySubmitJoin](input)),
      directRoutes: () => transport.request((client) => client[WS_METHODS.relayDirectRoutes]({})),
    },
    push: {
      register: (input) => transport.request((client) => client[WS_METHODS.pushRegister](input)),
      unregister: () => transport.request((client) => client[WS_METHODS.pushUnregister]({})),
      sendTest: () => transport.request((client) => client[WS_METHODS.pushSendTest]({})),
    },
    presence: {
      setViewing: (input) =>
        transport.request((client) => client[WS_METHODS.presenceSetViewing](input)),
    },
    scheduledTasks: {
      subscribe: (listener, options) =>
        transport.subscribe(
          (client) =>
            client[WS_METHODS.scheduledTasksSubscribe]({ supports: SCHEDULED_TASK_CLIENT_SUPPORT }),
          listener,
          { ...options, tag: WS_METHODS.scheduledTasksSubscribe },
        ),
      listRuns: (input) =>
        transport.request((client) =>
          client[WS_METHODS.scheduledTasksListRuns]({
            ...input,
            supports: SCHEDULED_TASK_CLIENT_SUPPORT,
          }),
        ),
      create: (input) =>
        transport.request((client) => client[WS_METHODS.scheduledTasksCreate](input)),
      update: (input) =>
        transport.request((client) => client[WS_METHODS.scheduledTasksUpdate](input)),
      remove: (input) =>
        transport.request((client) => client[WS_METHODS.scheduledTasksDelete](input)),
      runNow: (input) =>
        transport.request((client) => client[WS_METHODS.scheduledTasksRunNow](input)),
      respondRequest: (input) =>
        transport.request((client) => client[WS_METHODS.scheduledTasksRespondRequest](input)),
      webhookAddress: (input) =>
        transport.request((client) => client[WS_METHODS.scheduledTasksWebhookAddress](input)),
      rotateWebhookAddress: (input) =>
        transport.request((client) => client[WS_METHODS.scheduledTasksRotateWebhookAddress](input)),
      setWebhookSigningSecret: (input) =>
        transport.request((client) =>
          client[WS_METHODS.scheduledTasksSetWebhookSigningSecret](input),
        ),
      revealWebhookSigningSecret: (input) =>
        transport.request((client) =>
          client[WS_METHODS.scheduledTasksRevealWebhookSigningSecret](input),
        ),
      gitHubContext: (input) =>
        transport.request((client) => client[WS_METHODS.scheduledTasksGitHubContext](input)),
      connectGitHub: (input) =>
        transport.request((client) => client[WS_METHODS.scheduledTasksConnectGitHub](input)),
      disconnectGitHub: (input) =>
        transport.request((client) => client[WS_METHODS.scheduledTasksDisconnectGitHub](input)),
      listWebhookEvents: (input) =>
        transport.request((client) => client[WS_METHODS.scheduledTasksListWebhookEvents](input)),
      webhookEvent: (input) =>
        transport.request((client) => client[WS_METHODS.scheduledTasksWebhookEvent](input)),
      testWebhook: (input) =>
        transport.request((client) => client[WS_METHODS.scheduledTasksTestWebhook](input)),
      runWithWebhookEvent: (input) =>
        transport.request((client) => client[WS_METHODS.scheduledTasksRunWithWebhookEvent](input)),
      dismissWebhookAddressChange: (input) =>
        transport.request((client) =>
          client[WS_METHODS.scheduledTasksDismissWebhookAddressChange](input),
        ),
    },
    links: {
      subscribe: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.linksSubscribe]({}), listener, {
          ...options,
          tag: WS_METHODS.linksSubscribe,
        }),
      createInvite: (input) =>
        transport.request((client) => client[WS_METHODS.linksCreateInvite](input)),
      accept: (input) => transport.request((client) => client[WS_METHODS.linksAccept](input)),
      setAccess: (input) => transport.request((client) => client[WS_METHODS.linksSetAccess](input)),
      remove: (input) => transport.request((client) => client[WS_METHODS.linksRemove](input)),
      respondRequest: (input) =>
        transport.request((client) => client[WS_METHODS.linksRespondRequest](input)),
    },
    // Never replayed on a new socket: the user answers what is on screen, and
    // after a reconnect the fresh snapshot says what still waits.
    outsideAgents: {
      subscribe: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.outsideAgentsSubscribe]({}), listener, {
          ...options,
          tag: WS_METHODS.outsideAgentsSubscribe,
        }),
      approve: (input) =>
        transport.request((client) => client[WS_METHODS.outsideAgentsApprove](input)),
      deny: (input) => transport.request((client) => client[WS_METHODS.outsideAgentsDeny](input)),
      denyAll: () => transport.request((client) => client[WS_METHODS.outsideAgentsDenyAll]({})),
      resumeRequests: () =>
        transport.request((client) => client[WS_METHODS.outsideAgentsResumeRequests]({})),
      update: (input) =>
        transport.request((client) => client[WS_METHODS.outsideAgentsUpdate](input)),
      remove: (input) =>
        transport.request((client) => client[WS_METHODS.outsideAgentsRemove](input)),
      assistantCode: () =>
        transport.request((client) => client[WS_METHODS.outsideAgentsAssistantCode]({})),
      assistantCodeCancel: () =>
        transport.request((client) => client[WS_METHODS.outsideAgentsAssistantCodeCancel]({})),
      createKey: (input) =>
        transport.request((client) => client[WS_METHODS.outsideAgentsCreateKey](input)),
    },
    // Never replayed on a new socket: a start that may have landed is told by
    // the thread's own `move`, and a second one would only be refused.
    moves: {
      preview: (input) => transport.request((client) => client[WS_METHODS.movesPreview](input)),
      start: (input) => transport.request((client) => client[WS_METHODS.movesStart](input)),
      cancel: (input) => transport.request((client) => client[WS_METHODS.movesCancel](input)),
    },
    // Every call here is safe to send again: the reads are pure, a start is
    // the same job for the same setupId, and cancel and dismiss repeat as
    // no-ops. The files travel in readFiles and start (up to 8 MiB), so those
    // get the time a slow relay needs.
    projectSetups: {
      source: (input) =>
        transport.requestWithReconnectRetry(
          (client) => client[WS_METHODS.projectSetupsSource](input),
          { label: WS_METHODS.projectSetupsSource },
        ),
      readFiles: (input) =>
        transport.requestWithReconnectRetry(
          (client) => client[WS_METHODS.projectSetupsReadFiles](input),
          {
            label: WS_METHODS.projectSetupsReadFiles,
            attemptTimeoutMs: 120_000,
            totalBudgetMs: 180_000,
          },
        ),
      inspectDestination: (input) =>
        transport.requestWithReconnectRetry(
          (client) => client[WS_METHODS.projectSetupsInspectDestination](input),
          { label: WS_METHODS.projectSetupsInspectDestination },
        ),
      start: (input) =>
        transport.requestWithReconnectRetry(
          (client) => client[WS_METHODS.projectSetupsStart](input),
          {
            label: WS_METHODS.projectSetupsStart,
            attemptTimeoutMs: 120_000,
            totalBudgetMs: 180_000,
          },
        ),
      cancel: (input) =>
        transport.requestWithReconnectRetry(
          (client) => client[WS_METHODS.projectSetupsCancel](input),
          { label: WS_METHODS.projectSetupsCancel },
        ),
      dismiss: (input) =>
        transport.requestWithReconnectRetry(
          (client) => client[WS_METHODS.projectSetupsDismiss](input),
          { label: WS_METHODS.projectSetupsDismiss },
        ),
      subscribe: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.projectSetupsSubscribe]({}), listener, {
          ...options,
          tag: WS_METHODS.projectSetupsSubscribe,
        }),
    },
    orchestration: {
      // Commands are deduped server-side by commandId receipts, so re-sending
      // through socket drops and session swaps cannot double-apply. Without
      // this, a send racing a phone-link reconnect was simply lost.
      dispatchCommand: (input) => {
        const execute = (client: WsRpcProtocolClient) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand](input);
        // Starting voice is intentionally connection-bound. Replaying it on
        // a replacement socket would resurrect a microphone session after
        // the UI has already torn capture down.
        return isRealtimeStartCommand(input)
          ? transport.request(execute)
          : transport.requestWithReconnectRetry(execute, dispatchCommandRetryOptions(input));
      },
      // A hint while typing: never replayed on a new socket, since a stale
      // one would only start an agent nobody is typing to anymore.
      warmUpTurn: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.warmUpTurn](input)),
      getTurnDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getTurnDiff](input)),
      getFullThreadDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getFullThreadDiff](input)),
      getRevertPlan: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getRevertPlan](input)),
      searchThreads: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.searchThreads](input)),
      getTurnActivities: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getTurnActivities](input)),
      getArchivedShellSnapshot: () =>
        transport.request((client) =>
          client[ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]({}),
        ),
      subscribeShell: (listener, options) =>
        transport.subscribe(
          (client) => client[ORCHESTRATION_WS_METHODS.subscribeShell]({}),
          listener,
          { ...options, tag: ORCHESTRATION_WS_METHODS.subscribeShell },
        ),
      subscribeThread: (input, listener, options) =>
        transport.subscribe(
          (client) => client[ORCHESTRATION_WS_METHODS.subscribeThread](input),
          listener,
          { ...options, tag: ORCHESTRATION_WS_METHODS.subscribeThread },
        ),
    },
  };
}
