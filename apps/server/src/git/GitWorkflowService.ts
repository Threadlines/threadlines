import * as nodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import {
  GitManagerError,
  GitCommandError,
  type VcsCommitDetailsInput,
  type VcsCommitDetailsResult,
  type VcsCommitGraphInput,
  type VcsCommitGraphResult,
  type VcsDiscardChangesInput,
  type VcsDiscardChangesResult,
  type VcsStageChangesInput,
  type VcsStageChangesResult,
  type VcsUnstageChangesInput,
  type VcsUnstageChangesResult,
  type VcsWorkingTreeDiffInput,
  type VcsWorkingTreeDiffResult,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsMergeRefInput,
  type VcsMergeRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateTagInput,
  type VcsCreateTagResult,
  type VcsDeleteBranchInput,
  type VcsDeleteBranchResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type GitGenerateCommitMessageInput,
  type GitGenerateCommitMessageResult,
  type GitManagerServiceError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitPullRequestRefInput,
  type VcsApplyStashInput,
  type VcsApplyStashResult,
  type VcsCreateStashInput,
  type VcsCreateStashResult,
  type VcsDropStashInput,
  type VcsDropStashResult,
  type VcsListStashesInput,
  type VcsListStashesResult,
  type VcsPullInput,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
} from "@threadlines/contracts";

import { GitManager, type GitRunStackedActionOptions } from "./GitManager.ts";
import {
  GitVcsDriver,
  type GitRemoteStatusOptions,
  type GitWorktreeEntry,
} from "../vcs/GitVcsDriver.ts";
import { VcsDriverRegistry, type VcsDriverHandle } from "../vcs/VcsDriverRegistry.ts";
import { checkoutPresence } from "../vcs/CheckoutPresence.ts";

export interface GitWorkflowServiceShape {
  readonly status: (
    input: VcsStatusInput,
  ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
  readonly localStatus: (
    input: VcsStatusInput,
  ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
  readonly remoteStatus: (
    input: VcsStatusInput,
    options?: GitRemoteStatusOptions,
  ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
  readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
  readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
  readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
  readonly pullCurrentBranch: (
    input: VcsPullInput,
  ) => Effect.Effect<VcsPullResult, GitCommandError>;
  readonly listStashes: (
    input: VcsListStashesInput,
  ) => Effect.Effect<VcsListStashesResult, GitCommandError>;
  readonly createStash: (
    input: VcsCreateStashInput,
  ) => Effect.Effect<VcsCreateStashResult, GitCommandError>;
  readonly applyStash: (
    input: VcsApplyStashInput,
  ) => Effect.Effect<VcsApplyStashResult, GitCommandError>;
  readonly dropStash: (
    input: VcsDropStashInput,
  ) => Effect.Effect<VcsDropStashResult, GitCommandError>;
  readonly runStackedAction: (
    input: GitRunStackedActionInput,
    options?: GitRunStackedActionOptions,
  ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
  readonly generateCommitMessage: (
    input: GitGenerateCommitMessageInput,
  ) => Effect.Effect<GitGenerateCommitMessageResult, GitManagerServiceError>;
  readonly resolvePullRequest: (
    input: GitPullRequestRefInput,
  ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
  readonly preparePullRequestThread: (
    input: GitPreparePullRequestThreadInput,
  ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
  readonly listRefs: (input: VcsListRefsInput) => Effect.Effect<VcsListRefsResult, GitCommandError>;
  /** See GitVcsDriverShape.listWorktrees. Empty for a non-repository cwd. */
  readonly listWorktrees: (input: {
    readonly cwd: string;
  }) => Effect.Effect<ReadonlyArray<GitWorktreeEntry>, GitCommandError>;
  readonly commitGraph: (
    input: VcsCommitGraphInput,
  ) => Effect.Effect<VcsCommitGraphResult, GitCommandError>;
  readonly commitDetails: (
    input: VcsCommitDetailsInput,
  ) => Effect.Effect<VcsCommitDetailsResult, GitCommandError>;
  readonly workingTreeDiff: (
    input: VcsWorkingTreeDiffInput,
  ) => Effect.Effect<VcsWorkingTreeDiffResult, GitCommandError>;
  readonly discardChanges: (
    input: VcsDiscardChangesInput,
  ) => Effect.Effect<VcsDiscardChangesResult, GitCommandError>;
  readonly stageChanges: (
    input: VcsStageChangesInput,
  ) => Effect.Effect<VcsStageChangesResult, GitCommandError>;
  readonly unstageChanges: (
    input: VcsUnstageChangesInput,
  ) => Effect.Effect<VcsUnstageChangesResult, GitCommandError>;
  readonly createWorktree: (
    input: VcsCreateWorktreeInput,
  ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
  readonly removeWorktree: (input: VcsRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;
  readonly createRef: (
    input: VcsCreateRefInput,
  ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
  readonly createTag: (
    input: VcsCreateTagInput,
  ) => Effect.Effect<VcsCreateTagResult, GitCommandError>;
  readonly deleteBranch: (
    input: VcsDeleteBranchInput,
  ) => Effect.Effect<VcsDeleteBranchResult, GitCommandError>;
  readonly switchRef: (
    input: VcsSwitchRefInput,
  ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
  readonly mergeRef: (input: VcsMergeRefInput) => Effect.Effect<VcsMergeRefResult, GitCommandError>;
  readonly renameBranch: (input: {
    readonly cwd: string;
    readonly oldBranch: string;
    readonly newBranch: string;
  }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>;
}

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  GitWorkflowServiceShape
>()("threadlines/git/GitWorkflowService") {}

function withRepositoryContext<T extends VcsStatusLocalResult>(
  status: T,
  cwd: string,
  handle: VcsDriverHandle,
): T & Pick<VcsStatusLocalResult, "repositoryRoot" | "repositoryRootRelation"> {
  const repositoryRoot = handle.repository.rootPath;
  return {
    ...status,
    repositoryRoot,
    repositoryRootRelation:
      nodePath.resolve(repositoryRoot) === nodePath.resolve(cwd) ? "same" : "ancestor",
  };
}

const unsupportedGitWorkflow = (operation: string, cwd: string, detail: string) =>
  new GitManagerError({
    operation,
    detail: `${detail} (${cwd})`,
  });

const unsupportedGitCommand = (operation: string, cwd: string, detail: string) =>
  new GitCommandError({
    operation,
    command: "vcs-route",
    cwd,
    detail,
  });

function nonRepositoryLocalStatus(pathMissing = false): VcsStatusLocalResult {
  return {
    isRepo: false,
    ...(pathMissing ? { pathMissing: true } : {}),
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: null,
    headSha: null,
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
  };
}

function nonRepositoryStatus(pathMissing = false): VcsStatusResult {
  return {
    ...nonRepositoryLocalStatus(pathMissing),
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  };
}

function nonRepositoryListRefs(): VcsListRefsResult {
  return {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
  };
}

function nonRepositoryCommitGraph(): VcsCommitGraphResult {
  return {
    commits: [],
    truncated: false,
  };
}

export const make = Effect.fn("makeGitWorkflowService")(function* () {
  const registry = yield* VcsDriverRegistry;
  const git = yield* GitVcsDriver;
  const gitManager = yield* GitManager;
  const fileSystem = yield* FileSystem.FileSystem;

  /**
   * "Not a repository" and "not there at all" both arrive here as a null
   * driver handle, and the UI turns the first into an "Initialize Git" call to
   * action. Offering that for a checkout the user's agent deleted is worse than
   * unhelpful, so the two are separated before the status leaves the server.
   */
  const isPathMissing = (cwd: string) =>
    checkoutPresence(cwd).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.map((presence) => presence === "missing"),
    );

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry
      .resolve({ cwd })
      .pipe(
        Effect.mapError((error) =>
          unsupportedGitWorkflow(
            operation,
            cwd,
            error instanceof Error ? error.message : String(error),
          ),
        ),
      );
    if (handle.kind !== "git") {
      return yield* unsupportedGitWorkflow(
        operation,
        cwd,
        `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}.`,
      );
    }
  });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry
      .resolve({ cwd })
      .pipe(
        Effect.mapError((error) =>
          unsupportedGitCommand(
            operation,
            cwd,
            error instanceof Error ? error.message : String(error),
          ),
        ),
      );
    if (handle.kind !== "git") {
      return yield* unsupportedGitCommand(
        operation,
        cwd,
        `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      );
    }
  });

  const detectGitRepositoryForStatus = Effect.fn("GitWorkflowService.detectGitRepositoryForStatus")(
    function* (operation: string, cwd: string) {
      const handle = yield* registry
        .detect({ cwd })
        .pipe(
          Effect.mapError((error) =>
            unsupportedGitWorkflow(
              operation,
              cwd,
              error instanceof Error ? error.message : String(error),
            ),
          ),
        );
      if (!handle) {
        return null;
      }
      if (handle.kind !== "git") {
        return yield* unsupportedGitWorkflow(
          operation,
          cwd,
          `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}.`,
        );
      }
      return handle;
    },
  );

  const detectGitRepositoryForCommand = Effect.fn(
    "GitWorkflowService.detectGitRepositoryForCommand",
  )(function* (operation: string, cwd: string) {
    const handle = yield* registry
      .detect({ cwd })
      .pipe(
        Effect.mapError((error) =>
          unsupportedGitCommand(
            operation,
            cwd,
            error instanceof Error ? error.message : String(error),
          ),
        ),
      );
    if (!handle) {
      return false;
    }
    if (handle.kind !== "git") {
      return yield* unsupportedGitCommand(
        operation,
        cwd,
        `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      );
    }
    return true;
  });

  const routeGitManager =
    <Input extends { readonly cwd: string }, Output>(
      operation: string,
      run: (input: Input) => Effect.Effect<Output, GitManagerServiceError>,
    ) =>
    (input: Input) =>
      ensureGit(operation, input.cwd).pipe(Effect.andThen(run(input)));

  return GitWorkflowService.of({
    status: (input) =>
      detectGitRepositoryForStatus("GitWorkflowService.status", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle
            ? gitManager
                .status(input)
                .pipe(Effect.map((status) => withRepositoryContext(status, input.cwd, handle)))
            : isPathMissing(input.cwd).pipe(Effect.map(nonRepositoryStatus)),
        ),
      ),
    localStatus: (input) =>
      detectGitRepositoryForStatus("GitWorkflowService.localStatus", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle
            ? gitManager
                .localStatus(input)
                .pipe(Effect.map((status) => withRepositoryContext(status, input.cwd, handle)))
            : isPathMissing(input.cwd).pipe(Effect.map(nonRepositoryLocalStatus)),
        ),
      ),
    remoteStatus: (input, options) =>
      detectGitRepositoryForStatus("GitWorkflowService.remoteStatus", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle ? gitManager.remoteStatus(input, options) : Effect.succeed(null),
        ),
      ),
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    invalidateStatus: gitManager.invalidateStatus,
    pullCurrentBranch: (input) =>
      ensureGitCommand("GitWorkflowService.pullCurrentBranch", input.cwd).pipe(
        Effect.andThen(git.pullCurrentBranch(input)),
      ),
    listStashes: (input) =>
      ensureGitCommand("GitWorkflowService.listStashes", input.cwd).pipe(
        Effect.andThen(git.listStashes(input)),
      ),
    createStash: (input) =>
      ensureGitCommand("GitWorkflowService.createStash", input.cwd).pipe(
        Effect.andThen(git.createStash(input)),
      ),
    applyStash: (input) =>
      ensureGitCommand("GitWorkflowService.applyStash", input.cwd).pipe(
        Effect.andThen(git.applyStash(input)),
      ),
    dropStash: (input) =>
      ensureGitCommand("GitWorkflowService.dropStash", input.cwd).pipe(
        Effect.andThen(git.dropStash(input)),
      ),
    runStackedAction: (input, options) =>
      ensureGit("GitWorkflowService.runStackedAction", input.cwd).pipe(
        Effect.andThen(gitManager.runStackedAction(input, options)),
      ),
    generateCommitMessage: (input) =>
      ensureGit("GitWorkflowService.generateCommitMessage", input.cwd).pipe(
        Effect.andThen(gitManager.generateCommitMessage(input)),
      ),
    resolvePullRequest: routeGitManager(
      "GitWorkflowService.resolvePullRequest",
      gitManager.resolvePullRequest,
    ),
    preparePullRequestThread: routeGitManager(
      "GitWorkflowService.preparePullRequestThread",
      gitManager.preparePullRequestThread,
    ),
    listRefs: (input) =>
      detectGitRepositoryForCommand("GitWorkflowService.listRefs", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? git.listRefs(input) : Effect.succeed(nonRepositoryListRefs()),
        ),
      ),
    listWorktrees: (input) =>
      detectGitRepositoryForCommand("GitWorkflowService.listWorktrees", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository
            ? git.listWorktrees(input)
            : Effect.succeed<ReadonlyArray<GitWorktreeEntry>>([]),
        ),
      ),
    commitGraph: (input) =>
      detectGitRepositoryForCommand("GitWorkflowService.commitGraph", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? git.commitGraph(input) : Effect.succeed(nonRepositoryCommitGraph()),
        ),
      ),
    commitDetails: (input) =>
      ensureGitCommand("GitWorkflowService.commitDetails", input.cwd).pipe(
        Effect.andThen(git.commitDetails(input)),
      ),
    workingTreeDiff: (input) =>
      ensureGitCommand("GitWorkflowService.workingTreeDiff", input.cwd).pipe(
        Effect.andThen(git.workingTreeDiff(input)),
      ),
    discardChanges: (input) =>
      ensureGitCommand("GitWorkflowService.discardChanges", input.cwd).pipe(
        Effect.andThen(git.discardChanges(input)),
      ),
    stageChanges: (input) =>
      ensureGitCommand("GitWorkflowService.stageChanges", input.cwd).pipe(
        Effect.andThen(git.stageChanges(input)),
      ),
    unstageChanges: (input) =>
      ensureGitCommand("GitWorkflowService.unstageChanges", input.cwd).pipe(
        Effect.andThen(git.unstageChanges(input)),
      ),
    createWorktree: (input) =>
      ensureGitCommand("GitWorkflowService.createWorktree", input.cwd).pipe(
        Effect.andThen(git.createWorktree(input)),
      ),
    removeWorktree: (input) =>
      ensureGitCommand("GitWorkflowService.removeWorktree", input.cwd).pipe(
        Effect.andThen(git.removeWorktree(input)),
      ),
    createRef: (input) =>
      ensureGitCommand("GitWorkflowService.createRef", input.cwd).pipe(
        Effect.andThen(git.createRef(input)),
      ),
    createTag: (input) =>
      ensureGitCommand("GitWorkflowService.createTag", input.cwd).pipe(
        Effect.andThen(git.createTag(input)),
      ),
    deleteBranch: (input) =>
      ensureGitCommand("GitWorkflowService.deleteBranch", input.cwd).pipe(
        Effect.andThen(git.deleteBranch(input)),
      ),
    switchRef: (input) =>
      ensureGitCommand("GitWorkflowService.switchRef", input.cwd).pipe(
        Effect.andThen(Effect.scoped(git.switchRef(input))),
      ),
    mergeRef: (input) =>
      ensureGitCommand("GitWorkflowService.mergeRef", input.cwd).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const details = yield* git.statusDetails(input.cwd);
            if (details.behindCount > 0) {
              return yield* unsupportedGitCommand(
                "GitWorkflowService.mergeRef",
                input.cwd,
                "Cannot merge and push because the current branch is behind upstream. Pull first.",
              );
            }
            if (!details.hasUpstream) {
              yield* git.resolvePrimaryRemoteName(input.cwd).pipe(Effect.asVoid);
            }

            const merged = yield* git.mergeRef(input);
            const push = yield* git.pushCurrentBranch(input.cwd, merged.refName);
            return { ...merged, push };
          }),
        ),
      ),
    renameBranch: (input) =>
      ensureGit("GitWorkflowService.renameBranch", input.cwd).pipe(
        Effect.andThen(git.renameBranch(input)),
      ),
  });
});

export const layer = Layer.effect(GitWorkflowService, make());
