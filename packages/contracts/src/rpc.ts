import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { ExternalLauncherError, LaunchEditorInput } from "./editor.ts";
import { AuthAccessStreamEvent } from "./auth.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import {
  GitActionProgressEvent,
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
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
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
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationRpcSchemas,
} from "./orchestration.ts";
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
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
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
} from "./sourceControl.ts";
import { VcsError } from "./vcs.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsRefreshLocalStatus: "vcs.refreshLocalStatus",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCommitGraph: "vcs.commitGraph",
  vcsWorkingTreeDiff: "vcs.workingTreeDiff",
  vcsDiscardChanges: "vcs.discardChanges",
  vcsStageChanges: "vcs.stageChanges",
  vcsUnstageChanges: "vcs.unstageChanges",
  vcsCreateWorktree: "vcs.createWorktree",
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

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverSignalProcess: "server.signalProcess",
  serverGetProviderExtensions: "server.getProviderExtensions",
  serverStartProviderExtensionMcpOAuth: "server.startProviderExtensionMcpOAuth",
  serverGetProviderExtensionOperationStatus: "server.getProviderExtensionOperationStatus",
  serverReloadProviderExtensionMcpServers: "server.reloadProviderExtensionMcpServers",
  serverSetProviderExtensionSkillEnabled: "server.setProviderExtensionSkillEnabled",
  serverReadProviderExtensionPlugin: "server.readProviderExtensionPlugin",
  serverInstallProviderExtensionPlugin: "server.installProviderExtensionPlugin",
  serverUninstallProviderExtensionPlugin: "server.uninstallProviderExtensionPlugin",
  serverSetProviderExtensionPluginEnabled: "server.setProviderExtensionPluginEnabled",
  serverUpdateProviderExtensionPlugin: "server.updateProviderExtensionPlugin",
  serverRefreshProviderExtensionPluginMarketplaces:
    "server.refreshProviderExtensionPluginMarketplaces",
  serverCallProviderExtensionMcpTool: "server.callProviderExtensionMcpTool",
  serverReadProviderExtensionMcpResource: "server.readProviderExtensionMcpResource",
  serverGetProviderInstructionFiles: "server.getProviderInstructionFiles",
  serverWriteProviderInstructionFile: "server.writeProviderInstructionFile",

  // Source control methods
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlListRepositories: "sourceControl.listRepositories",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",

  // Streaming subscriptions
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

export const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: ServerProviderUpdateError,
});

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

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: LaunchEditorInput,
  error: ExternalLauncherError,
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: FilesystemBrowseError,
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

export const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: GitCommandError,
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
  WsServerUpdateProviderRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerSignalProcessRpc,
  WsServerGetProviderExtensionsRpc,
  WsServerStartProviderExtensionMcpOAuthRpc,
  WsServerGetProviderExtensionOperationStatusRpc,
  WsServerReloadProviderExtensionMcpServersRpc,
  WsServerSetProviderExtensionSkillEnabledRpc,
  WsServerReadProviderExtensionPluginRpc,
  WsServerInstallProviderExtensionPluginRpc,
  WsServerUninstallProviderExtensionPluginRpc,
  WsServerSetProviderExtensionPluginEnabledRpc,
  WsServerUpdateProviderExtensionPluginRpc,
  WsServerRefreshProviderExtensionPluginMarketplacesRpc,
  WsServerCallProviderExtensionMcpToolRpc,
  WsServerReadProviderExtensionMcpResourceRpc,
  WsServerGetProviderInstructionFilesRpc,
  WsServerWriteProviderInstructionFileRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlListRepositoriesRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsSubscribeVcsStatusRpc,
  WsVcsPullRpc,
  WsVcsRefreshLocalStatusRpc,
  WsVcsRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitGenerateCommitMessageRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsVcsListRefsRpc,
  WsVcsCommitGraphRpc,
  WsVcsWorkingTreeDiffRpc,
  WsVcsDiscardChangesRpc,
  WsVcsStageChangesRpc,
  WsVcsUnstageChangesRpc,
  WsVcsCreateWorktreeRpc,
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
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationReplayEventsRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);
