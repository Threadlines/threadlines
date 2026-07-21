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
  type ProviderSubagentTranscriptInput,
  type ProviderSubagentTranscriptResult,
  type ProviderStartReviewResult,
  type ServerSettingsPatch,
  WS_METHODS,
} from "@threadlines/contracts";
import { applyGitStatusStreamEvent } from "@threadlines/shared/git";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { type WsRpcProtocolClient } from "./protocol";
import { resetWsReconnectBackoff } from "./wsConnectionState";
import { WsTransport } from "./wsTransport";

type RpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends RpcTag> = WsRpcProtocolClient[TTag];
type RpcInput<TTag extends RpcTag> = Parameters<RpcMethod<TTag>>[0];

interface StreamSubscriptionOptions {
  readonly onResubscribe?: () => void;
}

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
    readonly onEvent: RpcStreamMethod<typeof WS_METHODS.subscribeTerminalEvents>;
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
  readonly filesystem: {
    readonly browse: RpcUnaryMethod<typeof WS_METHODS.filesystemBrowse>;
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
    }) => ReturnType<LocalApi["shell"]["openInEditor"]>;
  };
  readonly vcs: {
    readonly pull: RpcUnaryMethod<typeof WS_METHODS.vcsPull>;
    readonly refreshLocalStatus: RpcUnaryMethod<typeof WS_METHODS.vcsRefreshLocalStatus>;
    readonly refreshStatus: RpcUnaryMethod<typeof WS_METHODS.vcsRefreshStatus>;
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
    readonly consumeProviderRateLimitResetCredit: RpcUnaryMethod<
      typeof WS_METHODS.serverConsumeProviderRateLimitResetCredit
    >;
    readonly updateProvider: RpcUnaryMethod<typeof WS_METHODS.serverUpdateProvider>;
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
    readonly getTraceDiagnostics: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetTraceDiagnostics>;
    readonly getProcessDiagnostics: RpcUnaryNoArgMethod<
      typeof WS_METHODS.serverGetProcessDiagnostics
    >;
    readonly getProcessResourceHistory: RpcUnaryMethod<
      typeof WS_METHODS.serverGetProcessResourceHistory
    >;
    readonly signalProcess: RpcUnaryMethod<typeof WS_METHODS.serverSignalProcess>;
    readonly resolveBackgroundRuns: RpcUnaryMethod<typeof WS_METHODS.serverResolveBackgroundRuns>;
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
    readonly subscribeAuthAccess: RpcStreamMethod<typeof WS_METHODS.subscribeAuthAccess>;
  };
  readonly orchestration: {
    readonly dispatchCommand: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.dispatchCommand>;
    readonly getTurnDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getTurnDiff>;
    readonly getFullThreadDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff>;
    readonly getRevertPlan: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getRevertPlan>;
    readonly searchThreads: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.searchThreads>;
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

export function createWsRpcClient(transport: WsTransport): WsRpcClient {
  return {
    dispose: () => transport.dispose(),
    reconnect: async () => {
      resetWsReconnectBackoff();
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
      onEvent: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeTerminalEvents]({}), listener, {
          ...options,
          tag: WS_METHODS.subscribeTerminalEvents,
        }),
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
    filesystem: {
      browse: (input) => transport.request((client) => client[WS_METHODS.filesystemBrowse](input)),
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
      refreshLocalStatus: (input) =>
        transport.request((client) => client[WS_METHODS.vcsRefreshLocalStatus](input)),
      refreshStatus: (input) =>
        transport.request((client) => client[WS_METHODS.vcsRefreshStatus](input)),
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
    server: {
      getConfig: () => transport.request((client) => client[WS_METHODS.serverGetConfig]({})),
      refreshProviders: (input) =>
        transport.request((client) => client[WS_METHODS.serverRefreshProviders](input ?? {})),
      startProviderReview: (input) =>
        transport.request((client) => client[WS_METHODS.serverStartProviderReview](input)),
      readSubagentTranscript: (input) =>
        transport.request((client) => client[WS_METHODS.serverReadSubagentTranscript](input)),
      consumeProviderRateLimitResetCredit: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverConsumeProviderRateLimitResetCredit](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      updateProvider: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpdateProvider](input)),
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
      getProviderExtensions: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverGetProviderExtensions](input).pipe(
            Effect.withTracerEnabled(false),
          ),
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
      subscribeAuthAccess: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeAuthAccess]({}), listener, {
          ...options,
          tag: WS_METHODS.subscribeAuthAccess,
        }),
    },
    orchestration: {
      // Commands are deduped server-side by commandId receipts, so re-sending
      // through socket drops and session swaps cannot double-apply. Without
      // this, a send racing a phone-link reconnect was simply lost.
      dispatchCommand: (input) =>
        transport.requestWithReconnectRetry(
          (client) => client[ORCHESTRATION_WS_METHODS.dispatchCommand](input),
          dispatchCommandRetryOptions(input),
        ),
      getTurnDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getTurnDiff](input)),
      getFullThreadDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getFullThreadDiff](input)),
      getRevertPlan: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getRevertPlan](input)),
      searchThreads: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.searchThreads](input)),
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
