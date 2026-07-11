import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SourceControlProviderError, SourceControlProviderInfo } from "./sourceControl.ts";
import { VcsDriverKind } from "./vcs.ts";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const GIT_LIST_BRANCHES_MAX_LIMIT = 200;

// Domain Types

export const GitStackedAction = Schema.Literals([
  "commit",
  "push",
  "create_pr",
  "commit_push",
  "commit_push_pr",
]);
export type GitStackedAction = typeof GitStackedAction.Type;
export const GitActionProgressPhase = Schema.Literals(["branch", "commit", "push", "pr"]);
export type GitActionProgressPhase = typeof GitActionProgressPhase.Type;
export const GitActionProgressKind = Schema.Literals([
  "action_started",
  "phase_started",
  "hook_started",
  "hook_output",
  "hook_finished",
  "action_finished",
  "action_failed",
]);
export type GitActionProgressKind = typeof GitActionProgressKind.Type;
export const GitActionProgressStream = Schema.Literals(["stdout", "stderr"]);
export type GitActionProgressStream = typeof GitActionProgressStream.Type;
const GitCommitStepStatus = Schema.Literals([
  "created",
  "skipped_no_changes",
  "skipped_not_requested",
]);
const GitPushStepStatus = Schema.Literals([
  "pushed",
  "skipped_not_requested",
  "skipped_up_to_date",
]);
const GitBranchStepStatus = Schema.Literals(["created", "skipped_not_requested"]);
const GitPrStepStatus = Schema.Literals(["created", "opened_existing", "skipped_not_requested"]);
const VcsStatusChangeRequestState = Schema.Literals(["open", "closed", "merged"]);
export const VcsWorkingTreeFileChangeKind = Schema.Literals([
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "unmerged",
  "untracked",
]);
export type VcsWorkingTreeFileChangeKind = typeof VcsWorkingTreeFileChangeKind.Type;
const GitPullRequestReference = TrimmedNonEmptyStringSchema;
const GitPullRequestState = Schema.Literals(["open", "closed", "merged"]);
const GitPreparePullRequestThreadMode = Schema.Literals(["local", "worktree"]);
export const GitRunStackedActionToastRunAction = Schema.Struct({
  kind: GitStackedAction,
});
export type GitRunStackedActionToastRunAction = typeof GitRunStackedActionToastRunAction.Type;
const GitRunStackedActionToastCta = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("open_pr"),
    label: TrimmedNonEmptyStringSchema,
    url: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("run_action"),
    label: TrimmedNonEmptyStringSchema,
    action: GitRunStackedActionToastRunAction,
  }),
]);
export type GitRunStackedActionToastCta = typeof GitRunStackedActionToastCta.Type;
const GitRunStackedActionToast = Schema.Struct({
  title: TrimmedNonEmptyStringSchema,
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  cta: GitRunStackedActionToastCta,
});
export type GitRunStackedActionToast = typeof GitRunStackedActionToast.Type;

export const VcsRef = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  isRemote: Schema.optional(Schema.Boolean),
  remoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type VcsRef = typeof VcsRef.Type;

const VcsWorktree = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
});
const GitResolvedPullRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  state: GitPullRequestState,
});
export type GitResolvedPullRequest = typeof GitResolvedPullRequest.Type;

// RPC Inputs

export const VcsStatusInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsStatusInput = typeof VcsStatusInput.Type;

export const VcsPullInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsPullInput = typeof VcsPullInput.Type;

// Remote authentication failures classified from git stderr, and the
// remediation actions the server can apply on the user's behalf.

export const GitRemoteAuthScheme = Schema.Literals(["https", "ssh"]);
export type GitRemoteAuthScheme = typeof GitRemoteAuthScheme.Type;

export const GitRemoteAuthFailureKind = Schema.Literals([
  "https_credentials_unavailable",
  "https_credentials_rejected",
  "ssh_permission_denied",
  "ssh_host_key_verification_failed",
]);
export type GitRemoteAuthFailureKind = typeof GitRemoteAuthFailureKind.Type;

export const GitRemoteAuthFailure = Schema.Struct({
  kind: GitRemoteAuthFailureKind,
  scheme: GitRemoteAuthScheme,
  host: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type GitRemoteAuthFailure = typeof GitRemoteAuthFailure.Type;

export const GitAuthRemediationActionId = Schema.Literals(["gh_setup_git", "switch_remote_to_ssh"]);
export type GitAuthRemediationActionId = typeof GitAuthRemediationActionId.Type;

export const GitAuthRemediationAction = Schema.Struct({
  id: GitAuthRemediationActionId,
  title: TrimmedNonEmptyStringSchema,
  description: Schema.String,
  command: TrimmedNonEmptyStringSchema,
  applicable: Schema.Boolean,
  inapplicableReason: Schema.NullOr(Schema.String),
  recommended: Schema.Boolean,
});
export type GitAuthRemediationAction = typeof GitAuthRemediationAction.Type;

export const GitAuthRemediationPlanInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type GitAuthRemediationPlanInput = typeof GitAuthRemediationPlanInput.Type;

export const GitAuthRemediationPlan = Schema.Struct({
  remoteName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  remoteUrl: Schema.NullOr(TrimmedNonEmptyStringSchema),
  host: Schema.NullOr(TrimmedNonEmptyStringSchema),
  scheme: Schema.NullOr(GitRemoteAuthScheme),
  actions: Schema.Array(GitAuthRemediationAction),
});
export type GitAuthRemediationPlan = typeof GitAuthRemediationPlan.Type;

export const GitApplyAuthRemediationInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  actionId: GitAuthRemediationActionId,
});
export type GitApplyAuthRemediationInput = typeof GitApplyAuthRemediationInput.Type;

export const GitApplyAuthRemediationResult = Schema.Struct({
  actionId: GitAuthRemediationActionId,
  detail: TrimmedNonEmptyStringSchema,
});
export type GitApplyAuthRemediationResult = typeof GitApplyAuthRemediationResult.Type;

export const GitRunStackedActionInput = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
  commitMessage: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000))),
  featureBranch: Schema.optional(Schema.Boolean),
  filePaths: Schema.optional(
    Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1)),
  ),
});
export type GitRunStackedActionInput = typeof GitRunStackedActionInput.Type;

export const GitGenerateCommitMessageInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  filePaths: Schema.optional(
    Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1)),
  ),
});
export type GitGenerateCommitMessageInput = typeof GitGenerateCommitMessageInput.Type;

export const VcsListRefsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  query: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(256))),
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(GIT_LIST_BRANCHES_MAX_LIMIT)),
  ),
});
export type VcsListRefsInput = typeof VcsListRefsInput.Type;

export const VcsCommitGraphInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type VcsCommitGraphInput = typeof VcsCommitGraphInput.Type;

const VcsCommitSha = TrimmedNonEmptyStringSchema.check(Schema.isPattern(/^[0-9a-fA-F]{7,64}$/));

export const VcsCommitDetailsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  sha: VcsCommitSha,
});
export type VcsCommitDetailsInput = typeof VcsCommitDetailsInput.Type;

export const VcsWorkingTreeDiffInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  filePaths: Schema.optional(
    Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1)),
  ),
  ignoreWhitespace: Schema.optional(Schema.Boolean),
});
export type VcsWorkingTreeDiffInput = typeof VcsWorkingTreeDiffInput.Type;

export const VcsWorkingTreeDiffResult = Schema.Struct({
  diff: Schema.String,
});
export type VcsWorkingTreeDiffResult = typeof VcsWorkingTreeDiffResult.Type;

export const VcsDiscardChangesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  filePaths: Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1)),
  scope: Schema.optional(Schema.Literals(["all", "unstaged"])),
});
export type VcsDiscardChangesInput = typeof VcsDiscardChangesInput.Type;

export const VcsDiscardChangesResult = Schema.Struct({
  discardedPaths: Schema.Array(TrimmedNonEmptyStringSchema),
});
export type VcsDiscardChangesResult = typeof VcsDiscardChangesResult.Type;

export const VcsStageChangesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  filePaths: Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1)),
});
export type VcsStageChangesInput = typeof VcsStageChangesInput.Type;

export const VcsStageChangesResult = Schema.Struct({
  stagedPaths: Schema.Array(TrimmedNonEmptyStringSchema),
});
export type VcsStageChangesResult = typeof VcsStageChangesResult.Type;

export const VcsUnstageChangesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  filePaths: Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1)),
});
export type VcsUnstageChangesInput = typeof VcsUnstageChangesInput.Type;

export const VcsUnstageChangesResult = Schema.Struct({
  unstagedPaths: Schema.Array(TrimmedNonEmptyStringSchema),
});
export type VcsUnstageChangesResult = typeof VcsUnstageChangesResult.Type;

export const VcsCreateWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
  newRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  path: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type VcsCreateWorktreeInput = typeof VcsCreateWorktreeInput.Type;

export const GitPullRequestRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
});
export type GitPullRequestRefInput = typeof GitPullRequestRefInput.Type;

export const GitPreparePullRequestThreadInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  mode: GitPreparePullRequestThreadMode,
  threadId: Schema.optional(ThreadId),
});
export type GitPreparePullRequestThreadInput = typeof GitPreparePullRequestThreadInput.Type;

export const VcsRemoveWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  path: TrimmedNonEmptyStringSchema,
  force: Schema.optional(Schema.Boolean),
});
export type VcsRemoveWorktreeInput = typeof VcsRemoveWorktreeInput.Type;

export const VcsCreateRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
  switchRef: Schema.optional(Schema.Boolean),
});
export type VcsCreateRefInput = typeof VcsCreateRefInput.Type;

export const VcsCreateRefResult = Schema.Struct({
  refName: TrimmedNonEmptyStringSchema,
});
export type VcsCreateRefResult = typeof VcsCreateRefResult.Type;

export const VcsCreateTagInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  tagName: TrimmedNonEmptyStringSchema,
  targetSha: TrimmedNonEmptyStringSchema,
});
export type VcsCreateTagInput = typeof VcsCreateTagInput.Type;

export const VcsCreateTagResult = Schema.Struct({
  tagName: TrimmedNonEmptyStringSchema,
  targetSha: TrimmedNonEmptyStringSchema,
});
export type VcsCreateTagResult = typeof VcsCreateTagResult.Type;

export const VcsDeleteBranchInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  branchName: TrimmedNonEmptyStringSchema,
});
export type VcsDeleteBranchInput = typeof VcsDeleteBranchInput.Type;

export const VcsDeleteBranchResult = Schema.Struct({
  branchName: TrimmedNonEmptyStringSchema,
});
export type VcsDeleteBranchResult = typeof VcsDeleteBranchResult.Type;

export const VcsSwitchRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
});
export type VcsSwitchRefInput = typeof VcsSwitchRefInput.Type;

export const VcsMergeRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
});
export type VcsMergeRefInput = typeof VcsMergeRefInput.Type;

const VcsMergePushResult = Schema.Struct({
  status: Schema.Literals(["pushed", "skipped_up_to_date"]),
  branch: TrimmedNonEmptyStringSchema,
  upstreamBranch: Schema.optional(TrimmedNonEmptyStringSchema),
  setUpstream: Schema.optional(Schema.Boolean),
});

export const VcsMergeRefResult = Schema.Struct({
  refName: TrimmedNonEmptyStringSchema,
  push: Schema.optional(VcsMergePushResult),
});
export type VcsMergeRefResult = typeof VcsMergeRefResult.Type;

export const VcsInitInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  kind: Schema.optional(VcsDriverKind),
});
export type VcsInitInput = typeof VcsInitInput.Type;

// RPC Results

const VcsStatusChangeRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseRef: TrimmedNonEmptyStringSchema,
  headRef: TrimmedNonEmptyStringSchema,
  state: VcsStatusChangeRequestState,
});

const VcsStatusLocalShape = {
  isRepo: Schema.Boolean,
  sourceControlProvider: Schema.optional(SourceControlProviderInfo),
  /** Repository web URL derived from the tracked remote, e.g. `https://github.com/owner/repo`. */
  remoteWebUrl: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  hasPrimaryRemote: Schema.Boolean,
  isDefaultRef: Schema.Boolean,
  refName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  hasWorkingTreeChanges: Schema.Boolean,
  workingTree: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: TrimmedNonEmptyStringSchema,
        originalPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
        indexStatus: Schema.optional(Schema.NullOr(VcsWorkingTreeFileChangeKind)),
        worktreeStatus: Schema.optional(Schema.NullOr(VcsWorkingTreeFileChangeKind)),
        insertions: NonNegativeInt,
        deletions: NonNegativeInt,
        stagedInsertions: Schema.optional(NonNegativeInt),
        stagedDeletions: Schema.optional(NonNegativeInt),
        unstagedInsertions: Schema.optional(NonNegativeInt),
        unstagedDeletions: Schema.optional(NonNegativeInt),
      }),
    ),
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
};

const VcsStatusRemoteShape = {
  hasUpstream: Schema.Boolean,
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  aheadOfDefaultCount: Schema.optional(NonNegativeInt),
  pr: Schema.NullOr(VcsStatusChangeRequest),
};

export const VcsStatusLocalResult = Schema.Struct(VcsStatusLocalShape);
export type VcsStatusLocalResult = typeof VcsStatusLocalResult.Type;

export const VcsStatusRemoteResult = Schema.Struct(VcsStatusRemoteShape);
export type VcsStatusRemoteResult = typeof VcsStatusRemoteResult.Type;

export const VcsStatusResult = Schema.Struct({
  ...VcsStatusLocalShape,
  ...VcsStatusRemoteShape,
});
export type VcsStatusResult = typeof VcsStatusResult.Type;

export const VcsStatusStreamEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    local: VcsStatusLocalResult,
    remote: Schema.NullOr(VcsStatusRemoteResult),
  }),
  Schema.TaggedStruct("localUpdated", {
    local: VcsStatusLocalResult,
  }),
  Schema.TaggedStruct("remoteUpdated", {
    remote: Schema.NullOr(VcsStatusRemoteResult),
  }),
]);
export type VcsStatusStreamEvent = typeof VcsStatusStreamEvent.Type;

export const VcsListRefsResult = Schema.Struct({
  refs: Schema.Array(VcsRef),
  isRepo: Schema.Boolean,
  hasPrimaryRemote: Schema.Boolean,
  nextCursor: NonNegativeInt.pipe(Schema.NullOr),
  totalCount: NonNegativeInt,
});
export type VcsListRefsResult = typeof VcsListRefsResult.Type;

export const VcsCommitGraphCommit = Schema.Struct({
  sha: TrimmedNonEmptyStringSchema,
  shortSha: TrimmedNonEmptyStringSchema,
  parents: Schema.Array(TrimmedNonEmptyStringSchema),
  refs: Schema.Array(TrimmedNonEmptyStringSchema),
  subject: Schema.String,
  authorName: Schema.String,
  committedAt: Schema.String,
});
export type VcsCommitGraphCommit = typeof VcsCommitGraphCommit.Type;

export const VcsCommitGraphResult = Schema.Struct({
  commits: Schema.Array(VcsCommitGraphCommit),
  truncated: Schema.Boolean,
});
export type VcsCommitGraphResult = typeof VcsCommitGraphResult.Type;

export const VcsCommitDetailsResult = Schema.Struct({
  sha: TrimmedNonEmptyStringSchema,
  shortSha: TrimmedNonEmptyStringSchema,
  subject: Schema.String,
  body: Schema.String,
  message: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(100_000)),
  commitUrl: Schema.NullOr(Schema.String),
});
export type VcsCommitDetailsResult = typeof VcsCommitDetailsResult.Type;

export const VcsCreateWorktreeResult = Schema.Struct({
  worktree: VcsWorktree,
});
export type VcsCreateWorktreeResult = typeof VcsCreateWorktreeResult.Type;

export const GitResolvePullRequestResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
});
export type GitResolvePullRequestResult = typeof GitResolvePullRequestResult.Type;

export const GitPreparePullRequestThreadResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
  branch: TrimmedNonEmptyStringSchema,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type GitPreparePullRequestThreadResult = typeof GitPreparePullRequestThreadResult.Type;

export const VcsSwitchRefResult = Schema.Struct({
  refName: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type VcsSwitchRefResult = typeof VcsSwitchRefResult.Type;

export const GitRunStackedActionResult = Schema.Struct({
  action: GitStackedAction,
  branch: Schema.Struct({
    status: GitBranchStepStatus,
    name: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  commit: Schema.Struct({
    status: GitCommitStepStatus,
    commitSha: Schema.optional(TrimmedNonEmptyStringSchema),
    subject: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  push: Schema.Struct({
    status: GitPushStepStatus,
    branch: Schema.optional(TrimmedNonEmptyStringSchema),
    upstreamBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    setUpstream: Schema.optional(Schema.Boolean),
  }),
  pr: Schema.Struct({
    status: GitPrStepStatus,
    url: Schema.optional(Schema.String),
    number: Schema.optional(PositiveInt),
    baseBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    headBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    title: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  toast: GitRunStackedActionToast,
});
export type GitRunStackedActionResult = typeof GitRunStackedActionResult.Type;

export const GitGenerateCommitMessageResult = Schema.Struct({
  subject: TrimmedNonEmptyStringSchema,
  body: Schema.String,
  message: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000)),
});
export type GitGenerateCommitMessageResult = typeof GitGenerateCommitMessageResult.Type;

export const VcsPullResult = Schema.Struct({
  status: Schema.Literals(["pulled", "skipped_up_to_date"]),
  refName: TrimmedNonEmptyStringSchema,
  upstreamRef: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type VcsPullResult = typeof VcsPullResult.Type;

// RPC / domain errors
export class GitCommandError extends Schema.TaggedErrorClass<GitCommandError>()("GitCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  remoteAuth: Schema.optional(GitRemoteAuthFailure),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Git command failed in ${this.operation}: ${this.command} (${this.cwd}) - ${this.detail}`;
  }
}

export class TextGenerationError extends Schema.TaggedErrorClass<TextGenerationError>()(
  "TextGenerationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Text generation failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitManagerError extends Schema.TaggedErrorClass<GitManagerError>()("GitManagerError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Git manager failed in ${this.operation}: ${this.detail}`;
  }
}

export const GitManagerServiceError = Schema.Union([
  GitManagerError,
  GitCommandError,
  SourceControlProviderError,
  TextGenerationError,
]);
export type GitManagerServiceError = typeof GitManagerServiceError.Type;

const GitActionProgressBase = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
});

const GitActionStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_started"),
  phases: Schema.Array(GitActionProgressPhase),
});
const GitActionPhaseStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("phase_started"),
  phase: GitActionProgressPhase,
  label: TrimmedNonEmptyStringSchema,
});
const GitActionHookStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_started"),
  hookName: TrimmedNonEmptyStringSchema,
});
const GitActionHookOutputEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_output"),
  hookName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  stream: GitActionProgressStream,
  text: TrimmedNonEmptyStringSchema,
});
const GitActionHookFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_finished"),
  hookName: TrimmedNonEmptyStringSchema,
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(NonNegativeInt),
});
const GitActionFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_finished"),
  result: GitRunStackedActionResult,
});
const GitActionFailedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_failed"),
  phase: Schema.NullOr(GitActionProgressPhase),
  message: TrimmedNonEmptyStringSchema,
});

export const GitActionProgressEvent = Schema.Union([
  GitActionStartedEvent,
  GitActionPhaseStartedEvent,
  GitActionHookStartedEvent,
  GitActionHookOutputEvent,
  GitActionHookFinishedEvent,
  GitActionFinishedEvent,
  GitActionFailedEvent,
]);
export type GitActionProgressEvent = typeof GitActionProgressEvent.Type;
