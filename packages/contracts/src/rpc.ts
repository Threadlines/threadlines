import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { ExternalLauncherError, LaunchEditorInput } from "./editor.ts";
import { AuthAccessStreamEvent } from "./auth.ts";
import {
  PreviewAutomationHostSchema,
  PreviewAutomationRequestSchema,
  PreviewAutomationResponseSchema,
} from "./previewAutomation.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import { UsageReadError, UsageSummary, UsageSummaryInput } from "./usage.ts";
import {
  GitActionProgressEvent,
  VcsCommitDetailsInput,
  VcsCommitDetailsResult,
  VcsCommitGraphInput,
  VcsCommitGraphResult,
  VcsDiscardChangesInput,
  VcsDiscardChangesResult,
  VcsStageChangesInput,
  VcsStageChangesResult,
  VcsUnstageChangesInput,
  VcsUnstageChangesResult,
  VcsWorkingTreeDiffInput,
  VcsWorkingTreeDiffResult,
  VcsMergeRefInput,
  VcsMergeRefResult,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsWorktreeInUseError,
  GitGenerateCommitMessageInput,
  GitGenerateCommitMessageResult,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateTagInput,
  VcsCreateTagResult,
  VcsDeleteBranchInput,
  VcsDeleteBranchResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsListWorktreesInput,
  VcsListWorktreesResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitApplyAuthRemediationInput,
  GitApplyAuthRemediationResult,
  GitAuthRemediationPlan,
  GitAuthRemediationPlanInput,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsApplyStashInput,
  VcsApplyStashResult,
  VcsCreateStashInput,
  VcsCreateStashResult,
  VcsDropStashInput,
  VcsDropStashResult,
  VcsListStashesInput,
  VcsListStashesResult,
  VcsPullInput,
  GitPullRequestRefInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  VcsStatusInput,
  VcsStatusLocalResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "./git.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  ChatAttachmentReadError,
  ChatAttachmentReadInput,
  ChatAttachmentReadResult,
  CodexInlineVisualizationReadError,
  CodexInlineVisualizationReadInput,
  CodexInlineVisualizationReadResult,
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetRevertPlanError,
  OrchestrationGetRevertPlanInput,
  OrchestrationGetSnapshotError,
  OrchestrationThreadSearchError,
  OrchestrationThreadSearchInput,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationRpcSchemas,
} from "./orchestration.ts";
import {
  ProviderExternalThreadError,
  ProviderExternalThreadImportInput,
  ProviderExternalThreadImportResult,
  ProviderExternalThreadListInput,
  ProviderExternalThreadListResult,
  ProviderStartReviewError,
  ProviderStartReviewInput,
  ProviderStartReviewResult,
  ProviderRealtimeAppendAudioInput,
  ProviderRealtimeAudioChunk,
  ProviderRealtimeError,
  ProviderRealtimeStartInput,
  ProviderSubagentInputError,
  ProviderSubagentInputRequest,
  ProviderSubagentInputResult,
  ProviderSubagentTranscriptError,
  ProviderSubagentTranscriptInput,
  ProviderSubagentTranscriptResult,
} from "./provider.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ProviderExtensionMcpOAuthStartInput,
  ProviderExtensionMcpOAuthStartResult,
  ProviderExtensionMcpReloadInput,
  ProviderExtensionMcpReloadResult,
  ProviderExtensionMcpResourceReadInput,
  ProviderExtensionMcpResourceReadResult,
  ProviderExtensionMcpToolCallInput,
  ProviderExtensionMcpToolCallResult,
  ProviderExtensionMarketplaceAddInput,
  ProviderExtensionMarketplaceAddResult,
  ProviderExtensionMarketplaceRemoveInput,
  ProviderExtensionMarketplaceRemoveResult,
  ProviderExtensionOperationStatusInput,
  ProviderExtensionOperationStatusResult,
  ProviderExtensionPluginInstallInput,
  ProviderExtensionPluginInstallResult,
  ProviderExtensionPluginReadInput,
  ProviderExtensionPluginReadResult,
  ProviderExtensionPluginMarketplaceRefreshInput,
  ProviderExtensionPluginMarketplaceRefreshResult,
  ProviderExtensionPluginToggleInput,
  ProviderExtensionPluginToggleResult,
  ProviderExtensionPluginUninstallInput,
  ProviderExtensionPluginUninstallResult,
  ProviderExtensionPluginUpdateInput,
  ProviderExtensionPluginUpdateResult,
  ProviderExtensionSkillCreateInput,
  ProviderExtensionSkillCreateResult,
  ProviderExtensionSkillDeleteInput,
  ProviderExtensionSkillDeleteResult,
  ProviderExtensionSkillReadInput,
  ProviderExtensionSkillReadResult,
  ProviderExtensionSkillToggleInput,
  ProviderExtensionSkillToggleResult,
  ProviderExtensionsError,
  ProviderExtensionsInventoryInput,
  ProviderExtensionsInventoryResult,
  ProviderInstructionFilesInput,
  ProviderInstructionFilesResult,
  ProviderInstructionWriteInput,
  ProviderInstructionWriteResult,
} from "./providerExtensions.ts";
import {
  ProjectFaviconError,
  ProjectFaviconInput,
  ProjectFaviconResult,
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  ProviderAuthError,
  ProviderAuthEvent,
  ProviderAuthResizeInput,
  ProviderAuthStartInput,
  ProviderAuthStopInput,
  ProviderAuthSubscribeInput,
  ProviderAuthWriteInput,
} from "./providerAuth.ts";
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  ServerConfigStreamEvent,
  ServerConfig,
  ServerProviderRateLimitResetCreditConsumeInput,
  ServerProviderRateLimitResetCreditConsumeResult,
  ServerProviderRateLimitResetCreditError,
  ServerProviderUpdateBlockerResolutionResult,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerProviderUpdatedPayload,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerResolveBackgroundRunsInput,
  ServerResolveBackgroundRunsResult,
  ServerStopBackgroundRunInput,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";
import {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlListRepositoriesInput,
  SourceControlListRepositoriesResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
  SourceControlToolUpdateError,
  SourceControlToolUpdateInput,
  SourceControlToolUpdateResult,
} from "./sourceControl.ts";
import { VcsError } from "./vcs.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",
  projectsListEntries: "projects.listEntries",
  projectsReadFile: "projects.readFile",
  projectsFavicon: "projects.favicon",

  // Chat attachment methods
  attachmentsRead: "attachments.read",

  // Codex inline visualization methods
  visualizationsRead: "visualizations.read",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsListStashes: "vcs.listStashes",
  vcsCreateStash: "vcs.createStash",
  vcsApplyStash: "vcs.applyStash",
  vcsDropStash: "vcs.dropStash",
  vcsRefreshLocalStatus: "vcs.refreshLocalStatus",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCommitGraph: "vcs.commitGraph",
  vcsCommitDetails: "vcs.commitDetails",
  vcsWorkingTreeDiff: "vcs.workingTreeDiff",
  vcsDiscardChanges: "vcs.discardChanges",
  vcsStageChanges: "vcs.stageChanges",
  vcsUnstageChanges: "vcs.unstageChanges",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsListWorktrees: "vcs.listWorktrees",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsCreateTag: "vcs.createTag",
  vcsDeleteBranch: "vcs.deleteBranch",
  vcsSwitchRef: "vcs.switchRef",
  vcsMergeRef: "vcs.mergeRef",
  vcsInit: "vcs.init",

  // Git workflow methods
  gitRunStackedAction: "git.runStackedAction",
  gitGenerateCommitMessage: "git.generateCommitMessage",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",
  gitAuthRemediationPlan: "git.authRemediationPlan",
  gitApplyAuthRemediation: "git.applyAuthRemediation",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Provider sign-in methods (settings-owned, ephemeral PTY)
  providerAuthStart: "providerAuth.start",
  providerAuthWrite: "providerAuth.write",
  providerAuthResize: "providerAuth.resize",
  providerAuthStop: "providerAuth.stop",
  providerAuthSubscribe: "providerAuth.subscribe",

  // Realtime audio methods
  realtimeAppendAudio: "realtime.appendAudio",
  realtimeSubscribeAudio: "realtime.subscribeAudio",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverStartProviderReview: "server.startProviderReview",
  serverReadSubagentTranscript: "server.readSubagentTranscript",
  serverSendSubagentInput: "server.sendSubagentInput",
  serverListExternalProviderThreads: "server.listExternalProviderThreads",
  serverImportExternalProviderThread: "server.importExternalProviderThread",
  serverConsumeProviderRateLimitResetCredit: "server.consumeProviderRateLimitResetCredit",
  serverUpdateProvider: "server.updateProvider",
  serverResolveProviderUpdateBlockers: "server.resolveProviderUpdateBlockers",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverUpdateSourceControlTool: "server.updateSourceControlTool",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverSignalProcess: "server.signalProcess",
  serverResolveBackgroundRuns: "server.resolveBackgroundRuns",
  serverStopBackgroundRun: "server.stopBackgroundRun",
  serverGetProviderExtensions: "server.getProviderExtensions",
  serverStartProviderExtensionMcpOAuth: "server.startProviderExtensionMcpOAuth",
  serverGetProviderExtensionOperationStatus: "server.getProviderExtensionOperationStatus",
  serverReloadProviderExtensionMcpServers: "server.reloadProviderExtensionMcpServers",
  serverSetProviderExtensionSkillEnabled: "server.setProviderExtensionSkillEnabled",
  serverReadProviderExtensionSkill: "server.readProviderExtensionSkill",
  serverCreateProviderExtensionSkill: "server.createProviderExtensionSkill",
  serverDeleteProviderExtensionSkill: "server.deleteProviderExtensionSkill",
  serverReadProviderExtensionPlugin: "server.readProviderExtensionPlugin",
  serverInstallProviderExtensionPlugin: "server.installProviderExtensionPlugin",
  serverUninstallProviderExtensionPlugin: "server.uninstallProviderExtensionPlugin",
  serverSetProviderExtensionPluginEnabled: "server.setProviderExtensionPluginEnabled",
  serverUpdateProviderExtensionPlugin: "server.updateProviderExtensionPlugin",
  serverRefreshProviderExtensionPluginMarketplaces:
    "server.refreshProviderExtensionPluginMarketplaces",
  serverAddProviderExtensionMarketplace: "server.addProviderExtensionMarketplace",
  serverRemoveProviderExtensionMarketplace: "server.removeProviderExtensionMarketplace",
  serverCallProviderExtensionMcpTool: "server.callProviderExtensionMcpTool",
  serverReadProviderExtensionMcpResource: "server.readProviderExtensionMcpResource",
  serverGetProviderInstructionFiles: "server.getProviderInstructionFiles",
  serverWriteProviderInstructionFile: "server.writeProviderInstructionFile",

  // Usage reporting methods
  usageSummary: "usage.summary",

  // Source control methods
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlListRepositories: "sourceControl.listRepositories",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",

  // Streaming subscriptions
  previewAutomationConnect: "previewAutomationConnect",
  previewAutomationRespond: "previewAutomationRespond",
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
} as const;

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: KeybindingsConfigError,
});

export const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: KeybindingsConfigError,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
  }),
  success: ServerProviderUpdatedPayload,
});

export const WsServerStartProviderReviewRpc = Rpc.make(WS_METHODS.serverStartProviderReview, {
  payload: ProviderStartReviewInput,
  success: ProviderStartReviewResult,
  error: ProviderStartReviewError,
});

export const WsServerReadSubagentTranscriptRpc = Rpc.make(WS_METHODS.serverReadSubagentTranscript, {
  payload: ProviderSubagentTranscriptInput,
  success: ProviderSubagentTranscriptResult,
  error: ProviderSubagentTranscriptError,
});

export const WsServerSendSubagentInputRpc = Rpc.make(WS_METHODS.serverSendSubagentInput, {
  payload: ProviderSubagentInputRequest,
  success: ProviderSubagentInputResult,
  error: ProviderSubagentInputError,
});

export const WsServerListExternalProviderThreadsRpc = Rpc.make(
  WS_METHODS.serverListExternalProviderThreads,
  {
    payload: ProviderExternalThreadListInput,
    success: ProviderExternalThreadListResult,
    error: ProviderExternalThreadError,
  },
);

export const WsServerImportExternalProviderThreadRpc = Rpc.make(
  WS_METHODS.serverImportExternalProviderThread,
  {
    payload: ProviderExternalThreadImportInput,
    success: ProviderExternalThreadImportResult,
    error: ProviderExternalThreadError,
  },
);

export const WsServerConsumeProviderRateLimitResetCreditRpc = Rpc.make(
  WS_METHODS.serverConsumeProviderRateLimitResetCredit,
  {
    payload: ServerProviderRateLimitResetCreditConsumeInput,
    success: ServerProviderRateLimitResetCreditConsumeResult,
    error: ServerProviderRateLimitResetCreditError,
  },
);

export const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: ServerProviderUpdateError,
});

export const WsServerResolveProviderUpdateBlockersRpc = Rpc.make(
  WS_METHODS.serverResolveProviderUpdateBlockers,
  {
    payload: ServerProviderUpdateInput,
    success: ServerProviderUpdateBlockerResolutionResult,
    error: ServerProviderUpdateError,
  },
);

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
});

export const WsServerUpdateSourceControlToolRpc = Rpc.make(
  WS_METHODS.serverUpdateSourceControlTool,
  {
    payload: SourceControlToolUpdateInput,
    success: SourceControlToolUpdateResult,
    error: SourceControlToolUpdateError,
  },
);

export const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
});

export const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
});

export const WsServerGetProcessResourceHistoryRpc = Rpc.make(
  WS_METHODS.serverGetProcessResourceHistory,
  {
    payload: ServerProcessResourceHistoryInput,
    success: ServerProcessResourceHistoryResult,
  },
);

export const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
});

export const WsServerResolveBackgroundRunsRpc = Rpc.make(WS_METHODS.serverResolveBackgroundRuns, {
  payload: ServerResolveBackgroundRunsInput,
  success: ServerResolveBackgroundRunsResult,
});

export const WsServerStopBackgroundRunRpc = Rpc.make(WS_METHODS.serverStopBackgroundRun, {
  payload: ServerStopBackgroundRunInput,
  success: ServerSignalProcessResult,
});

export const WsServerGetProviderExtensionsRpc = Rpc.make(WS_METHODS.serverGetProviderExtensions, {
  payload: ProviderExtensionsInventoryInput,
  success: ProviderExtensionsInventoryResult,
  error: ProviderExtensionsError,
});

export const WsServerStartProviderExtensionMcpOAuthRpc = Rpc.make(
  WS_METHODS.serverStartProviderExtensionMcpOAuth,
  {
    payload: ProviderExtensionMcpOAuthStartInput,
    success: ProviderExtensionMcpOAuthStartResult,
    error: ProviderExtensionsError,
  },
);

export const WsServerGetProviderExtensionOperationStatusRpc = Rpc.make(
  WS_METHODS.serverGetProviderExtensionOperationStatus,
  {
    payload: ProviderExtensionOperationStatusInput,
    success: ProviderExtensionOperationStatusResult,
    error: ProviderExtensionsError,
  },
);

export const WsServerReloadProviderExtensionMcpServersRpc = Rpc.make(
  WS_METHODS.serverReloadProviderExtensionMcpServers,
  {
    payload: ProviderExtensionMcpReloadInput,
    success: ProviderExtensionMcpReloadResult,
    error: ProviderExtensionsError,
  },
);

export const WsServerSetProviderExtensionSkillEnabledRpc = Rpc.make(
  WS_METHODS.serverSetProviderExtensionSkillEnabled,
  {
    payload: ProviderExtensionSkillToggleInput,
    success: ProviderExtensionSkillToggleResult,
    error: ProviderExtensionsError,
  },
);

export const WsServerReadProviderExtensionSkillRpc = Rpc.make(
  WS_METHODS.serverReadProviderExtensionSkill,
  {
    payload: ProviderExtensionSkillReadInput,
    success: ProviderExtensionSkillReadResult,
    error: ProviderExtensionsError,
  },
);

export const WsServerCreateProviderExtensionSkillRpc = Rpc.make(
  WS_METHODS.serverCreateProviderExtensionSkill,
  {
    payload: ProviderExtensionSkillCreateInput,
    success: ProviderExtensionSkillCreateResult,
    error: ProviderExtensionsError,
  },
);

export const WsServerDeleteProviderExtensionSkillRpc = Rpc.make(
  WS_METHODS.serverDeleteProviderExtensionSkill,
  {
    payload: ProviderExtensionSkillDeleteInput,
    success: ProviderExtensionSkillDeleteResult,
    error: ProviderExtensionsError,
  },
);

export const WsServerReadProviderExtensionPluginRpc = Rpc.make(
  WS_METHODS.serverReadProviderExtensionPlugin,
  {
    payload: ProviderExtensionPluginReadInput,
    success: ProviderExtensionPluginReadResult,
    error: ProviderExtensionsError,
  },
);

export const WsServerInstallProviderExtensionPluginRpc = Rpc.make(
  WS_METHODS.serverInstallProviderExtensionPlugin,
  {
    payload: ProviderExtensionPluginInstallInput,
    success: ProviderExtensionPluginInstallResult,
    error: ProviderExtensionsError,
  },
);

export const WsServerUninstallProviderExtensionPluginRpc = Rpc.make(
  WS_METHODS.serverUninstallProviderExtensionPlugin,
  {
    payload: ProviderExtensionPluginUninstallInput,
    success: ProviderExtensionPluginUninstallResult,
    error: ProviderExtensionsError,
  },
);

export const WsServerSetProviderExtensionPluginEnabledRpc = Rpc.make(
  WS_METHODS.serverSetProviderExtensionPluginEnabled,
  {
    payload: ProviderExtensionPluginToggleInput,
    success: ProviderExtensionPluginToggleResult,
    error: ProviderExtensionsError,
  },
);

export const WsServerUpdateProviderExtensionPluginRpc = Rpc.make(
  WS_METHODS.serverUpdateProviderExtensionPlugin,
  {
    payload: ProviderExtensionPluginUpdateInput,
    success: ProviderExtensionPluginUpdateResult,
    error: ProviderExtensionsError,
  },
);

export const WsServerRefreshProviderExtensionPluginMarketplacesRpc = Rpc.make(
  WS_METHODS.serverRefreshProviderExtensionPluginMarketplaces,
  {
    payload: ProviderExtensionPluginMarketplaceRefreshInput,
    success: ProviderExtensionPluginMarketplaceRefreshResult,
    error: ProviderExtensionsError,
  },
);

export const WsServerAddProviderExtensionMarketplaceRpc = Rpc.make(
  WS_METHODS.serverAddProviderExtensionMarketplace,
  {
    payload: ProviderExtensionMarketplaceAddInput,
    success: ProviderExtensionMarketplaceAddResult,
    error: ProviderExtensionsError,
  },
);

export const WsServerRemoveProviderExtensionMarketplaceRpc = Rpc.make(
  WS_METHODS.serverRemoveProviderExtensionMarketplace,
  {
    payload: ProviderExtensionMarketplaceRemoveInput,
    success: ProviderExtensionMarketplaceRemoveResult,
    error: ProviderExtensionsError,
  },
);

export const WsServerCallProviderExtensionMcpToolRpc = Rpc.make(
  WS_METHODS.serverCallProviderExtensionMcpTool,
  {
    payload: ProviderExtensionMcpToolCallInput,
    success: ProviderExtensionMcpToolCallResult,
    error: ProviderExtensionsError,
  },
);

export const WsServerReadProviderExtensionMcpResourceRpc = Rpc.make(
  WS_METHODS.serverReadProviderExtensionMcpResource,
  {
    payload: ProviderExtensionMcpResourceReadInput,
    success: ProviderExtensionMcpResourceReadResult,
    error: ProviderExtensionsError,
  },
);

export const WsServerGetProviderInstructionFilesRpc = Rpc.make(
  WS_METHODS.serverGetProviderInstructionFiles,
  {
    payload: ProviderInstructionFilesInput,
    success: ProviderInstructionFilesResult,
    error: ProviderExtensionsError,
  },
);

export const WsServerWriteProviderInstructionFileRpc = Rpc.make(
  WS_METHODS.serverWriteProviderInstructionFile,
  {
    payload: ProviderInstructionWriteInput,
    success: ProviderInstructionWriteResult,
    error: ProviderExtensionsError,
  },
);

export const WsSourceControlLookupRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlLookupRepository,
  {
    payload: SourceControlRepositoryLookupInput,
    success: SourceControlRepositoryInfo,
    error: SourceControlRepositoryError,
  },
);

export const WsSourceControlListRepositoriesRpc = Rpc.make(
  WS_METHODS.sourceControlListRepositories,
  {
    payload: SourceControlListRepositoriesInput,
    success: SourceControlListRepositoriesResult,
    error: SourceControlRepositoryError,
  },
);

export const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: SourceControlRepositoryError,
});

export const WsSourceControlPublishRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlPublishRepository,
  {
    payload: SourceControlPublishRepositoryInput,
    success: SourceControlPublishRepositoryResult,
    error: SourceControlRepositoryError,
  },
);

export const WsUsageSummaryRpc = Rpc.make(WS_METHODS.usageSummary, {
  payload: UsageSummaryInput,
  success: UsageSummary,
  error: UsageReadError,
});

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: ProjectSearchEntriesError,
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: ProjectWriteFileError,
});

export const WsProjectsListEntriesRpc = Rpc.make(WS_METHODS.projectsListEntries, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: ProjectListEntriesError,
});

export const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: ProjectReadFileError,
});

export const WsProjectsFaviconRpc = Rpc.make(WS_METHODS.projectsFavicon, {
  payload: ProjectFaviconInput,
  success: ProjectFaviconResult,
  error: ProjectFaviconError,
});

export const WsAttachmentsReadRpc = Rpc.make(WS_METHODS.attachmentsRead, {
  payload: ChatAttachmentReadInput,
  success: ChatAttachmentReadResult,
  error: ChatAttachmentReadError,
});

export const WsVisualizationsReadRpc = Rpc.make(WS_METHODS.visualizationsRead, {
  payload: CodexInlineVisualizationReadInput,
  success: CodexInlineVisualizationReadResult,
  error: CodexInlineVisualizationReadError,
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: LaunchEditorInput,
  error: ExternalLauncherError,
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: FilesystemBrowseError,
});

/**
 * A client offering itself as the browser for one thread, and the requests it
 * is then sent.
 *
 * A subscription rather than polling because the server is the one with
 * something to say: a tool call arrives when the agent decides it does, and the
 * client cannot know to ask. Ending the subscription is how the browser panel
 * says it is gone -- closing it, navigating away, or the socket dropping all
 * arrive here as the same event, which is the point.
 */
export const WsPreviewAutomationConnectRpc = Rpc.make(WS_METHODS.previewAutomationConnect, {
  payload: PreviewAutomationHostSchema,
  success: PreviewAutomationRequestSchema,
  stream: true,
});

/** The answer to one of those requests. Fire and forget: the caller waiting on
 *  it is a provider turn on the other side of the broker, not this client. */
export const WsPreviewAutomationRespondRpc = Rpc.make(WS_METHODS.previewAutomationRespond, {
  payload: PreviewAutomationResponseSchema,
  success: Schema.Void,
});

export const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusInput,
  success: VcsStatusStreamEvent,
  error: GitManagerServiceError,
  stream: true,
});

export const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: GitCommandError,
});

export const WsVcsListStashesRpc = Rpc.make(WS_METHODS.vcsListStashes, {
  payload: VcsListStashesInput,
  success: VcsListStashesResult,
  error: GitCommandError,
});

export const WsVcsCreateStashRpc = Rpc.make(WS_METHODS.vcsCreateStash, {
  payload: VcsCreateStashInput,
  success: VcsCreateStashResult,
  error: GitCommandError,
});

export const WsVcsApplyStashRpc = Rpc.make(WS_METHODS.vcsApplyStash, {
  payload: VcsApplyStashInput,
  success: VcsApplyStashResult,
  error: GitCommandError,
});

export const WsVcsDropStashRpc = Rpc.make(WS_METHODS.vcsDropStash, {
  payload: VcsDropStashInput,
  success: VcsDropStashResult,
  error: GitCommandError,
});

export const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: GitManagerServiceError,
});

export const WsVcsRefreshLocalStatusRpc = Rpc.make(WS_METHODS.vcsRefreshLocalStatus, {
  payload: VcsStatusInput,
  success: VcsStatusLocalResult,
  error: GitManagerServiceError,
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: GitManagerServiceError,
  stream: true,
});

export const WsGitGenerateCommitMessageRpc = Rpc.make(WS_METHODS.gitGenerateCommitMessage, {
  payload: GitGenerateCommitMessageInput,
  success: GitGenerateCommitMessageResult,
  error: GitManagerServiceError,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: GitManagerServiceError,
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: GitManagerServiceError,
});

export const WsGitAuthRemediationPlanRpc = Rpc.make(WS_METHODS.gitAuthRemediationPlan, {
  payload: GitAuthRemediationPlanInput,
  success: GitAuthRemediationPlan,
  error: GitManagerServiceError,
});

export const WsGitApplyAuthRemediationRpc = Rpc.make(WS_METHODS.gitApplyAuthRemediation, {
  payload: GitApplyAuthRemediationInput,
  success: GitApplyAuthRemediationResult,
  error: GitManagerServiceError,
});

export const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: GitCommandError,
});

export const WsVcsCommitGraphRpc = Rpc.make(WS_METHODS.vcsCommitGraph, {
  payload: VcsCommitGraphInput,
  success: VcsCommitGraphResult,
  error: GitCommandError,
});

export const WsVcsCommitDetailsRpc = Rpc.make(WS_METHODS.vcsCommitDetails, {
  payload: VcsCommitDetailsInput,
  success: VcsCommitDetailsResult,
  error: GitCommandError,
});

export const WsVcsWorkingTreeDiffRpc = Rpc.make(WS_METHODS.vcsWorkingTreeDiff, {
  payload: VcsWorkingTreeDiffInput,
  success: VcsWorkingTreeDiffResult,
  error: GitCommandError,
});

export const WsVcsDiscardChangesRpc = Rpc.make(WS_METHODS.vcsDiscardChanges, {
  payload: VcsDiscardChangesInput,
  success: VcsDiscardChangesResult,
  error: GitCommandError,
});

export const WsVcsStageChangesRpc = Rpc.make(WS_METHODS.vcsStageChanges, {
  payload: VcsStageChangesInput,
  success: VcsStageChangesResult,
  error: GitCommandError,
});

export const WsVcsUnstageChangesRpc = Rpc.make(WS_METHODS.vcsUnstageChanges, {
  payload: VcsUnstageChangesInput,
  success: VcsUnstageChangesResult,
  error: GitCommandError,
});

export const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  payload: VcsCreateWorktreeInput,
  success: VcsCreateWorktreeResult,
  error: GitCommandError,
});

export const WsVcsListWorktreesRpc = Rpc.make(WS_METHODS.vcsListWorktrees, {
  payload: VcsListWorktreesInput,
  success: VcsListWorktreesResult,
  error: GitCommandError,
});

export const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  // Removal is refused outright while a thread still works in the folder, so
  // callers get a distinct error naming them rather than a git failure.
  error: Schema.Union([GitCommandError, VcsWorktreeInUseError]),
});

export const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: GitCommandError,
});

export const WsVcsCreateTagRpc = Rpc.make(WS_METHODS.vcsCreateTag, {
  payload: VcsCreateTagInput,
  success: VcsCreateTagResult,
  error: GitCommandError,
});

export const WsVcsDeleteBranchRpc = Rpc.make(WS_METHODS.vcsDeleteBranch, {
  payload: VcsDeleteBranchInput,
  success: VcsDeleteBranchResult,
  error: GitCommandError,
});

export const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: GitCommandError,
});

export const WsVcsMergeRefRpc = Rpc.make(WS_METHODS.vcsMergeRef, {
  payload: VcsMergeRefInput,
  success: VcsMergeRefResult,
  error: GitCommandError,
});

export const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: VcsError,
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: TerminalError,
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: TerminalError,
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: TerminalError,
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: TerminalError,
});

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: OrchestrationDispatchCommandError,
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: OrchestrationGetTurnDiffError,
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: OrchestrationGetFullThreadDiffError,
  },
);

export const WsOrchestrationGetRevertPlanRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getRevertPlan, {
  payload: OrchestrationGetRevertPlanInput,
  success: OrchestrationRpcSchemas.getRevertPlan.output,
  error: OrchestrationGetRevertPlanError,
});

export const WsOrchestrationSearchThreadsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.searchThreads, {
  payload: OrchestrationThreadSearchInput,
  success: OrchestrationRpcSchemas.searchThreads.output,
  error: OrchestrationThreadSearchError,
});

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationReplayEventsInput,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: OrchestrationReplayEventsError,
});

export const WsOrchestrationGetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationRpcSchemas.getArchivedShellSnapshot.output,
    error: OrchestrationGetSnapshotError,
  },
);

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: OrchestrationGetSnapshotError,
  stream: true,
});

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationRpcSchemas.subscribeThread.output,
    error: OrchestrationGetSnapshotError,
    stream: true,
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  stream: true,
});

export const WsProviderAuthStartRpc = Rpc.make(WS_METHODS.providerAuthStart, {
  payload: ProviderAuthStartInput,
  success: Schema.Void,
  error: ProviderAuthError,
});

export const WsProviderAuthWriteRpc = Rpc.make(WS_METHODS.providerAuthWrite, {
  payload: ProviderAuthWriteInput,
  success: Schema.Void,
  error: ProviderAuthError,
});

export const WsProviderAuthResizeRpc = Rpc.make(WS_METHODS.providerAuthResize, {
  payload: ProviderAuthResizeInput,
  success: Schema.Void,
  error: ProviderAuthError,
});

export const WsProviderAuthStopRpc = Rpc.make(WS_METHODS.providerAuthStop, {
  payload: ProviderAuthStopInput,
  success: Schema.Void,
  error: ProviderAuthError,
});

export const WsProviderAuthSubscribeRpc = Rpc.make(WS_METHODS.providerAuthSubscribe, {
  payload: ProviderAuthSubscribeInput,
  success: ProviderAuthEvent,
  stream: true,
});

export const WsRealtimeAppendAudioRpc = Rpc.make(WS_METHODS.realtimeAppendAudio, {
  payload: ProviderRealtimeAppendAudioInput,
  success: Schema.Void,
  error: ProviderRealtimeError,
});

export const WsRealtimeSubscribeAudioRpc = Rpc.make(WS_METHODS.realtimeSubscribeAudio, {
  payload: ProviderRealtimeStartInput,
  success: ProviderRealtimeAudioChunk,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  stream: true,
});

export const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  stream: true,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerStartProviderReviewRpc,
  WsServerReadSubagentTranscriptRpc,
  WsServerSendSubagentInputRpc,
  WsServerListExternalProviderThreadsRpc,
  WsServerImportExternalProviderThreadRpc,
  WsServerConsumeProviderRateLimitResetCreditRpc,
  WsServerUpdateProviderRpc,
  WsServerResolveProviderUpdateBlockersRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerUpdateSourceControlToolRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerSignalProcessRpc,
  WsServerResolveBackgroundRunsRpc,
  WsServerStopBackgroundRunRpc,
  WsServerGetProviderExtensionsRpc,
  WsServerStartProviderExtensionMcpOAuthRpc,
  WsServerGetProviderExtensionOperationStatusRpc,
  WsServerReloadProviderExtensionMcpServersRpc,
  WsServerSetProviderExtensionSkillEnabledRpc,
  WsServerReadProviderExtensionSkillRpc,
  WsServerCreateProviderExtensionSkillRpc,
  WsServerDeleteProviderExtensionSkillRpc,
  WsServerReadProviderExtensionPluginRpc,
  WsServerInstallProviderExtensionPluginRpc,
  WsServerUninstallProviderExtensionPluginRpc,
  WsServerSetProviderExtensionPluginEnabledRpc,
  WsServerUpdateProviderExtensionPluginRpc,
  WsServerRefreshProviderExtensionPluginMarketplacesRpc,
  WsServerAddProviderExtensionMarketplaceRpc,
  WsServerRemoveProviderExtensionMarketplaceRpc,
  WsServerCallProviderExtensionMcpToolRpc,
  WsServerReadProviderExtensionMcpResourceRpc,
  WsServerGetProviderInstructionFilesRpc,
  WsServerWriteProviderInstructionFileRpc,
  WsUsageSummaryRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlListRepositoriesRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsProjectsListEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsFaviconRpc,
  WsAttachmentsReadRpc,
  WsVisualizationsReadRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsSubscribeVcsStatusRpc,
  WsVcsPullRpc,
  WsVcsListStashesRpc,
  WsVcsCreateStashRpc,
  WsVcsApplyStashRpc,
  WsVcsDropStashRpc,
  WsVcsRefreshLocalStatusRpc,
  WsVcsRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitGenerateCommitMessageRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsGitAuthRemediationPlanRpc,
  WsGitApplyAuthRemediationRpc,
  WsVcsListRefsRpc,
  WsVcsCommitGraphRpc,
  WsVcsCommitDetailsRpc,
  WsVcsWorkingTreeDiffRpc,
  WsVcsDiscardChangesRpc,
  WsVcsStageChangesRpc,
  WsVcsUnstageChangesRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsListWorktreesRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsCreateTagRpc,
  WsVcsDeleteBranchRpc,
  WsVcsSwitchRefRpc,
  WsVcsMergeRefRpc,
  WsVcsInitRpc,
  WsTerminalOpenRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsProviderAuthStartRpc,
  WsProviderAuthWriteRpc,
  WsProviderAuthResizeRpc,
  WsProviderAuthStopRpc,
  WsProviderAuthSubscribeRpc,
  WsRealtimeAppendAudioRpc,
  WsRealtimeSubscribeAudioRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationGetRevertPlanRpc,
  WsOrchestrationSearchThreadsRpc,
  WsOrchestrationReplayEventsRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);
