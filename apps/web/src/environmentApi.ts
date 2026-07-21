import type { EnvironmentId, EnvironmentApi } from "@threadlines/contracts";

import type { WsRpcClient } from "./rpc/wsRpcClient";
import { readEnvironmentConnection } from "./environments/runtime";

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
    projects: {
      searchEntries: rpcClient.projects.searchEntries,
      writeFile: rpcClient.projects.writeFile,
      listEntries: rpcClient.projects.listEntries,
      readFile: rpcClient.projects.readFile,
      favicon: rpcClient.projects.favicon,
    },
    providers: {
      getExtensions: rpcClient.server.getProviderExtensions,
    },
    attachments: {
      read: rpcClient.attachments.read,
    },
    filesystem: {
      browse: rpcClient.filesystem.browse,
    },
    sourceControl: {
      lookupRepository: rpcClient.sourceControl.lookupRepository,
      listRepositories: rpcClient.sourceControl.listRepositories,
      cloneRepository: rpcClient.sourceControl.cloneRepository,
      publishRepository: rpcClient.sourceControl.publishRepository,
    },
    vcs: {
      pull: rpcClient.vcs.pull,
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
