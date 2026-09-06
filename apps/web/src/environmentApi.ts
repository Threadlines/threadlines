import type { EnvironmentId, EnvironmentApi } from "@threadlines/contracts";
import { useSyncExternalStore } from "react";

import type { WsRpcClient } from "./rpc/wsRpcClient";
import { readEnvironmentConnection, subscribeEnvironmentConnections } from "./environments/runtime";

const environmentApiOverridesForTests = new Map<EnvironmentId, EnvironmentApi>();

export function createEnvironmentApi(rpcClient: WsRpcClient): EnvironmentApi {
  return {
    terminal: {
      open: (input) => rpcClient.terminal.open(input as never),
      write: (input) => rpcClient.terminal.write(input as never),
      resize: (input) => rpcClient.terminal.resize(input as never),
      clear: (input) => rpcClient.terminal.clear(input as never),
      restart: (input) => rpcClient.terminal.restart(input as never),
      close: (input) => rpcClient.terminal.close(input as never),
      onEvent: (callback) => rpcClient.terminal.onEvent(callback),
    },
    realtime: {
      appendAudio: rpcClient.realtime.appendAudio,
      subscribeAudio: (input, callback, options?: { readonly onComplete?: () => void }) =>
        rpcClient.realtime.subscribeAudio(input, callback, options),
    },
    previewAutomation: {
      connect: (input, listener) => rpcClient.previewAutomation.connect(input, listener),
      respond: (response) => rpcClient.previewAutomation.respond(response),
    },
    projects: {
      searchEntries: rpcClient.projects.searchEntries,
      writeFile: rpcClient.projects.writeFile,
      listEntries: rpcClient.projects.listEntries,
      readFile: rpcClient.projects.readFile,
      favicon: rpcClient.projects.favicon,
    },
    providers: {
      getExtensions: rpcClient.server.getProviderExtensions,
      startExtensionMcpOAuth: rpcClient.server.startProviderExtensionMcpOAuth,
      getExtensionOperationStatus: rpcClient.server.getProviderExtensionOperationStatus,
      reloadExtensionMcpServers: rpcClient.server.reloadProviderExtensionMcpServers,
      setExtensionSkillEnabled: rpcClient.server.setProviderExtensionSkillEnabled,
      createExtensionSkill: rpcClient.server.createProviderExtensionSkill,
      deleteExtensionSkill: rpcClient.server.deleteProviderExtensionSkill,
      readExtensionSkill: rpcClient.server.readProviderExtensionSkill,
      readExtensionPlugin: rpcClient.server.readProviderExtensionPlugin,
      installExtensionPlugin: rpcClient.server.installProviderExtensionPlugin,
      uninstallExtensionPlugin: rpcClient.server.uninstallProviderExtensionPlugin,
      setExtensionPluginEnabled: rpcClient.server.setProviderExtensionPluginEnabled,
      updateExtensionPlugin: rpcClient.server.updateProviderExtensionPlugin,
      refreshExtensionPluginMarketplaces:
        rpcClient.server.refreshProviderExtensionPluginMarketplaces,
      addExtensionMarketplace: rpcClient.server.addProviderExtensionMarketplace,
      removeExtensionMarketplace: rpcClient.server.removeProviderExtensionMarketplace,
      callExtensionMcpTool: rpcClient.server.callProviderExtensionMcpTool,
      readExtensionMcpResource: rpcClient.server.readProviderExtensionMcpResource,
      getInstructionFiles: rpcClient.server.getProviderInstructionFiles,
      writeInstructionFile: rpcClient.server.writeProviderInstructionFile,
    },
    attachments: {
      read: rpcClient.attachments.read,
    },
    visualizations: {
      read: rpcClient.visualizations.read,
    },
    filesystem: {
      browse: rpcClient.filesystem.browse,
    },
    usage: {
      summary: rpcClient.usage.summary,
    },
    sourceControl: {
      lookupRepository: rpcClient.sourceControl.lookupRepository,
      listRepositories: rpcClient.sourceControl.listRepositories,
      cloneRepository: rpcClient.sourceControl.cloneRepository,
      publishRepository: rpcClient.sourceControl.publishRepository,
    },
    vcs: {
      pull: rpcClient.vcs.pull,
      listStashes: rpcClient.vcs.listStashes,
      createStash: rpcClient.vcs.createStash,
      applyStash: rpcClient.vcs.applyStash,
      dropStash: rpcClient.vcs.dropStash,
      refreshLocalStatus: rpcClient.vcs.refreshLocalStatus,
      refreshStatus: rpcClient.vcs.refreshStatus,
      onStatus: (input, callback, options) => rpcClient.vcs.onStatus(input, callback, options),
      listRefs: rpcClient.vcs.listRefs,
      commitGraph: rpcClient.vcs.commitGraph,
      commitDetails: rpcClient.vcs.commitDetails,
      workingTreeDiff: rpcClient.vcs.workingTreeDiff,
      discardChanges: rpcClient.vcs.discardChanges,
      stageChanges: rpcClient.vcs.stageChanges,
      unstageChanges: rpcClient.vcs.unstageChanges,
      createWorktree: rpcClient.vcs.createWorktree,
      listWorktrees: rpcClient.vcs.listWorktrees,
      removeWorktree: rpcClient.vcs.removeWorktree,
      createRef: rpcClient.vcs.createRef,
      createTag: rpcClient.vcs.createTag,
      deleteBranch: rpcClient.vcs.deleteBranch,
      switchRef: rpcClient.vcs.switchRef,
      mergeRef: rpcClient.vcs.mergeRef,
      init: rpcClient.vcs.init,
    },
    git: {
      generateCommitMessage: rpcClient.git.generateCommitMessage,
      resolvePullRequest: rpcClient.git.resolvePullRequest,
      preparePullRequestThread: rpcClient.git.preparePullRequestThread,
      authRemediationPlan: rpcClient.git.authRemediationPlan,
      applyAuthRemediation: rpcClient.git.applyAuthRemediation,
    },
    pullRequests: {
      list: rpcClient.pullRequests.list,
      detail: rpcClient.pullRequests.detail,
      activity: rpcClient.pullRequests.activity,
      diff: rpcClient.pullRequests.diff,
      comment: rpcClient.pullRequests.comment,
      runAction: rpcClient.pullRequests.runAction,
      submitReview: rpcClient.pullRequests.submitReview,
      replyToThread: rpcClient.pullRequests.replyToThread,
      setThreadResolution: rpcClient.pullRequests.setThreadResolution,
      setReaction: rpcClient.pullRequests.setReaction,
      update: rpcClient.pullRequests.update,
      updateComment: rpcClient.pullRequests.updateComment,
      reviewerCandidates: rpcClient.pullRequests.reviewerCandidates,
      requestReviewers: rpcClient.pullRequests.requestReviewers,
    },
    orchestration: {
      dispatchCommand: rpcClient.orchestration.dispatchCommand,
      getTurnDiff: rpcClient.orchestration.getTurnDiff,
      getFullThreadDiff: rpcClient.orchestration.getFullThreadDiff,
      getRevertPlan: rpcClient.orchestration.getRevertPlan,
      searchThreads: rpcClient.orchestration.searchThreads,
      getArchivedShellSnapshot: rpcClient.orchestration.getArchivedShellSnapshot,
      subscribeShell: (callback, options) =>
        rpcClient.orchestration.subscribeShell(callback, options),
      subscribeThread: (input, callback, options) =>
        rpcClient.orchestration.subscribeThread(input, callback, options),
    },
  };
}

export function readEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  if (!environmentId) {
    return undefined;
  }

  const overriddenApi = environmentApiOverridesForTests.get(environmentId);
  if (overriddenApi) {
    return overriddenApi;
  }

  const connection = readEnvironmentConnection(environmentId);
  return connection ? createEnvironmentApi(connection.client) : undefined;
}

/**
 * Tracks whether an environment can currently accept API calls. Saved
 * environments are registered asynchronously during startup and can briefly
 * disappear while an SSH or relay connection is rebuilt, so render-time
 * consumers must not treat a missing connection as a permanent invariant
 * violation.
 */
export function useEnvironmentApiAvailable(
  environmentId: EnvironmentId | null | undefined,
): boolean {
  return useSyncExternalStore(
    subscribeEnvironmentConnections,
    () => (environmentId ? readEnvironmentApi(environmentId) !== undefined : false),
    () => false,
  );
}

export function ensureEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi {
  const api = readEnvironmentApi(environmentId);
  if (!api) {
    throw new Error(`Environment API not found for environment ${environmentId}`);
  }
  return api;
}

export function __setEnvironmentApiOverrideForTests(
  environmentId: EnvironmentId,
  api: EnvironmentApi,
): void {
  environmentApiOverridesForTests.set(environmentId, api);
}

export function __resetEnvironmentApiOverridesForTests(): void {
  environmentApiOverridesForTests.clear();
}
