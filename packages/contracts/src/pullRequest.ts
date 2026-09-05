import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

/** Which slice of a project's pull requests a listing asks for. */
export const PullRequestListState = Schema.Literals(["open", "merged", "closed"]);
export type PullRequestListState = typeof PullRequestListState.Type;

export const PullRequestState = Schema.Literals(["open", "merged", "closed"]);
export type PullRequestState = typeof PullRequestState.Type;

export const PullRequestReviewDecision = Schema.Literals([
  "approved",
  "changes-requested",
  "review-required",
]);
export type PullRequestReviewDecision = typeof PullRequestReviewDecision.Type;

export const PullRequestChecksState = Schema.Literals(["pending", "success", "failure"]);
export type PullRequestChecksState = typeof PullRequestChecksState.Type;

export const PullRequestMergeability = Schema.Literals(["mergeable", "conflicting", "unknown"]);
export type PullRequestMergeability = typeof PullRequestMergeability.Type;

/**
 * Whether the host's own rules would take a merge right now. `blocked` is a
 * protection rule in the way: required checks still running or failed, a
 * review still owed. `behind` is a host that insists the branch be current
 * first. `clear` is a merge the host would accept. Conflicts are `mergeability`,
 * not this.
 */
export const PullRequestMergeGate = Schema.Literals(["clear", "blocked", "behind"]);
export type PullRequestMergeGate = typeof PullRequestMergeGate.Type;

export const PullRequestActor = Schema.Struct({
  login: TrimmedNonEmptyString,
  isBot: Schema.Boolean,
  /** The host's picture for this account; null where it names none. */
  avatarUrl: Schema.NullOr(Schema.String),
});
export type PullRequestActor = typeof PullRequestActor.Type;

/** `color` is the hex triplet without a leading `#`, exactly as the host reports it. */
export const PullRequestLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.NullOr(Schema.String),
});
export type PullRequestLabel = typeof PullRequestLabel.Type;

/**
 * Where a row came from. A workspace row is one of the repositories the
 * workspace points at; an authored row came from a search for the viewer's own
 * pull requests and may name a repository no project here has checked out.
 */
export const PullRequestListEntryOrigin = Schema.Literals(["workspace", "authored"]);
export type PullRequestListEntryOrigin = typeof PullRequestListEntryOrigin.Type;

/**
 * One pull request as the pull requests page renders it: the host's fields plus
 * the project it belongs to and how it relates to the signed-in viewer.
 */
export const PullRequestListEntry = Schema.Struct({
  provider: SourceControlProviderKind,
  /**
   * The project whose checkout runs the host's tool for this row. An authored
   * row borrows a project on the same host, so it does not name the row's own
   * repository.
   */
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  /** `owner/name`. */
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** When the row merged or closed. Absent while open, or where the host did not say. */
  settledAt: Schema.optionalKey(IsoDateTime),
  viewerIsAuthor: Schema.Boolean,
  viewerReviewRequested: Schema.Boolean,
  /**
   * Push access on this row's repository: whether the viewer could merge it or
   * update its branch at all. Absent where the host did not say, and a page
   * reading it then keeps whatever it does for a host that never says.
   */
  viewerCanWrite: Schema.optionalKey(Schema.Boolean),
  /** Absent when the host reports no decision. */
  reviewDecision: Schema.optionalKey(PullRequestReviewDecision),
  /** Absent when there are no checks, or when checks were not requested. */
  checksState: Schema.optionalKey(PullRequestChecksState),
  /** Absent where the host does not say whether the branch still merges. */
  mergeability: Schema.optionalKey(PullRequestMergeability),
  labels: Schema.Array(PullRequestLabel),
  origin: PullRequestListEntryOrigin,
});
export type PullRequestListEntry = typeof PullRequestListEntry.Type;

export const PullRequestListProjectErrorReason = Schema.Literals([
  "missing-tool",
  "unauthenticated",
  "rate-limited",
  "failed",
]);
export type PullRequestListProjectErrorReason = typeof PullRequestListProjectErrorReason.Type;

/** One project the listing could not read. The other projects still return. */
export const PullRequestListProjectError = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  repository: Schema.NullOr(TrimmedNonEmptyString),
  reason: PullRequestListProjectErrorReason,
  detail: Schema.String,
});
export type PullRequestListProjectError = typeof PullRequestListProjectError.Type;

export const PullRequestListInput = Schema.Struct({
  state: PullRequestListState,
  /** Limits the listing to one project; every eligible project otherwise. */
  projectId: Schema.optionalKey(ProjectId),
  /** Drops the cached result for this listing before reading. */
  force: Schema.optionalKey(Schema.Boolean),
  /**
   * Whether the viewer's own pull requests on repositories the workspace does
   * not point at join the listing. On unless a caller turns it off.
   */
  includeAuthored: Schema.optionalKey(Schema.Boolean),
});
export type PullRequestListInput = typeof PullRequestListInput.Type;

export const PullRequestListResult = Schema.Struct({
  /** The signed-in host login, or null when it could not be determined. */
  viewer: Schema.NullOr(Schema.String),
  entries: Schema.Array(PullRequestListEntry),
  errors: Schema.Array(PullRequestListProjectError),
});
export type PullRequestListResult = typeof PullRequestListResult.Type;

export class PullRequestServiceError extends Schema.TaggedError<PullRequestServiceError>()(
  "PullRequestServiceError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Pull request service failed in ${this.operation}: ${this.detail}`;
  }
}

/**
 * Points at one pull request. The project names the checkout whose host tool
 * runs the call; the repository is the one it addresses, which is not the
 * project's own remote for a pull request the viewer opened elsewhere.
 */
export const PullRequestRef = Schema.Struct({
  projectId: ProjectId,
  /** `owner/name`, in whatever spelling the host reports. */
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type PullRequestRef = typeof PullRequestRef.Type;

export const PullRequestCheckStatus = Schema.Literals(["pending", "success", "failure", "skipped"]);
export type PullRequestCheckStatus = typeof PullRequestCheckStatus.Type;

/** One run in the host's check rollup, as the detail surface lists it. */
export const PullRequestCheck = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: PullRequestCheckStatus,
  description: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
});
export type PullRequestCheck = typeof PullRequestCheck.Type;

export const PullRequestReviewState = Schema.Literals([
  "approved",
  "changes-requested",
  "commented",
  "dismissed",
]);
export type PullRequestReviewState = typeof PullRequestReviewState.Type;

/** A review verdict, or `pending` while the host is still waiting for one. */
export const PullRequestReviewerState = Schema.Literals([
  "approved",
  "changes-requested",
  "commented",
  "dismissed",
  "pending",
]);
export type PullRequestReviewerState = typeof PullRequestReviewerState.Type;

/** A reviewer is a person or a team; only a team is addressed by a slug. */
export const PullRequestReviewerKind = Schema.Literals(["user", "team"]);
export type PullRequestReviewerKind = typeof PullRequestReviewerKind.Type;

export const PullRequestReviewer = Schema.Struct({
  /** How a reviewer request addresses this reviewer: a login, or a team slug. */
  id: TrimmedNonEmptyString,
  kind: PullRequestReviewerKind,
  login: TrimmedNonEmptyString,
  state: PullRequestReviewerState,
  /** The host's picture for this reviewer; null where it names none. */
  avatarUrl: Schema.NullOr(Schema.String),
});
export type PullRequestReviewer = typeof PullRequestReviewer.Type;

/** Which half of a diff a line belongs to: the old file, or the new one. */
export const PullRequestDiffSide = Schema.Literals(["left", "right"]);
export type PullRequestDiffSide = typeof PullRequestDiffSide.Type;

/** The eight reactions every host that has reactions at all agrees on. */
export const PullRequestReactionContent = Schema.Literals([
  "thumbs-up",
  "thumbs-down",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
]);
export type PullRequestReactionContent = typeof PullRequestReactionContent.Type;

/** One reaction, counted across everyone, with the viewer's own choice marked. */
export const PullRequestReaction = Schema.Struct({
  content: PullRequestReactionContent,
  count: NonNegativeInt,
  viewerReacted: Schema.Boolean,
});
export type PullRequestReaction = typeof PullRequestReaction.Type;

export const PullRequestCommentKind = Schema.Literals(["issue-comment", "review"]);
export type PullRequestCommentKind = typeof PullRequestCommentKind.Type;

/** One entry in the conversation: a plain comment, or a review with a verdict. */
export const PullRequestComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: PullRequestCommentKind,
  author: Schema.NullOr(PullRequestActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  url: Schema.NullOr(Schema.String),
  /** Set on reviews only; a plain comment carries no verdict. */
  reviewState: Schema.NullOr(PullRequestReviewState),
  reactions: Schema.Array(PullRequestReaction),
  /** Whether the viewer may rewrite this remark's words. */
  viewerIsAuthor: Schema.Boolean,
});
export type PullRequestComment = typeof PullRequestComment.Type;

/** One remark inside a review conversation pinned to a diff line. */
export const PullRequestThreadComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  url: Schema.NullOr(Schema.String),
  reactions: Schema.Array(PullRequestReaction),
  viewerIsAuthor: Schema.Boolean,
});
export type PullRequestThreadComment = typeof PullRequestThreadComment.Type;

/**
 * One conversation on a diff line. `line` is null once the host reports the
 * thread outdated: the line it hung on has left the diff, so it is listed
 * rather than pinned.
 */
export const PullRequestReviewThread = Schema.Struct({
  id: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  line: Schema.NullOr(PositiveInt),
  side: PullRequestDiffSide,
  isResolved: Schema.Boolean,
  isOutdated: Schema.Boolean,
  comments: Schema.Array(PullRequestThreadComment),
});
export type PullRequestReviewThread = typeof PullRequestReviewThread.Type;

export const PullRequestCommit = Schema.Struct({
  oid: TrimmedNonEmptyString,
  messageHeadline: Schema.String,
  committedDate: IsoDateTime,
  authorLogin: Schema.NullOr(Schema.String),
});
export type PullRequestCommit = typeof PullRequestCommit.Type;

/** How the host is allowed to land a pull request, as the repository settings say. */
export const PullRequestMergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type PullRequestMergeMethod = typeof PullRequestMergeMethod.Type;

/** How a branch is brought up to date with its base. */
export const PullRequestUpdateMethod = Schema.Literals(["merge", "rebase"]);
export type PullRequestUpdateMethod = typeof PullRequestUpdateMethod.Type;

/** The writes the detail header offers. `draft` is the reverse of `ready`. */
export const PullRequestAction = Schema.Literals([
  "merge",
  "close",
  "reopen",
  "ready",
  "draft",
  "update-branch",
  "enable-auto-merge",
  "disable-auto-merge",
]);
export type PullRequestAction = typeof PullRequestAction.Type;

export const PullRequestReviewVerdict = Schema.Literals(["approve", "request-changes", "comment"]);
export type PullRequestReviewVerdict = typeof PullRequestReviewVerdict.Type;

/** What a host lets a reviewer do to a conversation on a diff line. */
export const PullRequestReviewCapabilities = Schema.Struct({
  inlineComment: Schema.Boolean,
  reply: Schema.Boolean,
  resolve: Schema.Boolean,
  verdicts: Schema.Array(PullRequestReviewVerdict),
});
export type PullRequestReviewCapabilities = typeof PullRequestReviewCapabilities.Type;

export const PullRequestReviewerCapabilities = Schema.Struct({
  request: Schema.Boolean,
  listCandidates: Schema.Boolean,
});
export type PullRequestReviewerCapabilities = typeof PullRequestReviewerCapabilities.Type;

export const PullRequestEditCapabilities = Schema.Struct({
  pullRequest: Schema.Boolean,
  comment: Schema.Boolean,
});
export type PullRequestEditCapabilities = typeof PullRequestEditCapabilities.Type;

/**
 * What this host can do with this pull request. The client hides a control the
 * host lacks; the service refuses a call the capabilities do not allow before
 * anything runs, so a stale client cannot reach past them.
 */
export const PullRequestCapabilities = Schema.Struct({
  diff: Schema.Boolean,
  comment: Schema.Boolean,
  actions: Schema.Array(PullRequestAction),
  /** What the repository itself allows, not what the host supports in general. */
  mergeMethods: Schema.Array(PullRequestMergeMethod),
  updateMethods: Schema.Array(PullRequestUpdateMethod),
  reactions: Schema.Boolean,
  review: PullRequestReviewCapabilities,
  reviewers: PullRequestReviewerCapabilities,
  edit: PullRequestEditCapabilities,
});
export type PullRequestCapabilities = typeof PullRequestCapabilities.Type;

/** Where the head branch stands against its base. */
export const PullRequestBaseComparison = Schema.Literals(["up-to-date", "behind", "unknown"]);
export type PullRequestBaseComparison = typeof PullRequestBaseComparison.Type;

/**
 * What the signed-in viewer may do to this pull request. The client hides what
 * it cannot do; the host still decides, and refuses anything that slips past.
 */
export const PullRequestViewerPermissions = Schema.Struct({
  /** Push access on the repository: merge, update the branch, auto-merge. */
  canWrite: Schema.Boolean,
  /** Signed in and not the author, since a host refuses a self-review. */
  canReview: Schema.Boolean,
  /**
   * Push access or authorship, which is what a host lets the author do to their
   * own pull request: close, reopen, ready, draft, and the title and description.
   */
  canManage: Schema.Boolean,
});
export type PullRequestViewerPermissions = typeof PullRequestViewerPermissions.Type;

/**
 * Everything the detail surface renders above its tabs. The project fields
 * carry the workspace context the markdown renderer and hand-offs need.
 */
export const PullRequestDetail = Schema.Struct({
  provider: SourceControlProviderKind,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  state: PullRequestState,
  isDraft: Schema.Boolean,
  mergeability: PullRequestMergeability,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  mergedAt: Schema.NullOr(IsoDateTime),
  closedAt: Schema.NullOr(IsoDateTime),
  viewerIsAuthor: Schema.Boolean,
  reviewDecision: Schema.optionalKey(PullRequestReviewDecision),
  /** Requested users as `pending`, then everyone who has reviewed. */
  reviewers: Schema.Array(PullRequestReviewer),
  labels: Schema.Array(PullRequestLabel),
  checks: Schema.Array(PullRequestCheck),
  checksState: Schema.optionalKey(PullRequestChecksState),
  /** Absent where the host does not say, or has not decided yet after a push. */
  mergeGate: Schema.optionalKey(PullRequestMergeGate),
  viewer: PullRequestViewerPermissions,
  /** The methods the repository allows, in the order merge, squash, rebase. */
  mergeMethods: Schema.Array(PullRequestMergeMethod),
  capabilities: PullRequestCapabilities,
  baseComparison: PullRequestBaseComparison,
  /** Null where the host could not compare the branch with its base. */
  behindBy: Schema.NullOr(NonNegativeInt),
  /** Null where the host does not say whether it is armed to merge on its own. */
  autoMergeEnabled: Schema.NullOr(Schema.Boolean),
  /** The base is not the repository's default branch, so this sits on other work. */
  isStacked: Schema.Boolean,
  defaultBranch: Schema.NullOr(Schema.String),
});
export type PullRequestDetail = typeof PullRequestDetail.Type;

/** The conversation and commits, read separately so the header renders first. */
export const PullRequestActivity = Schema.Struct({
  /** Oldest first. */
  comments: Schema.Array(PullRequestComment),
  commits: Schema.Array(PullRequestCommit),
  reviewThreads: Schema.Array(PullRequestReviewThread),
  /** The pull request description's own reactions. */
  reactions: Schema.Array(PullRequestReaction),
});
export type PullRequestActivity = typeof PullRequestActivity.Type;

/** `truncated` means the host's patch did not fit and the tail was dropped. */
export const PullRequestDiffResult = Schema.Struct({
  patch: Schema.String,
  truncated: Schema.Boolean,
});
export type PullRequestDiffResult = typeof PullRequestDiffResult.Type;

export const PullRequestDetailInput = Schema.Struct({
  ...PullRequestRef.fields,
  /** Drops the cached read before running. */
  force: Schema.optionalKey(Schema.Boolean),
});
export type PullRequestDetailInput = typeof PullRequestDetailInput.Type;

export const PullRequestActivityInput = Schema.Struct({
  ...PullRequestRef.fields,
  force: Schema.optionalKey(Schema.Boolean),
});
export type PullRequestActivityInput = typeof PullRequestActivityInput.Type;

export const PullRequestDiffInput = Schema.Struct({
  ...PullRequestRef.fields,
  force: Schema.optionalKey(Schema.Boolean),
});
export type PullRequestDiffInput = typeof PullRequestDiffInput.Type;

export const PULL_REQUEST_COMMENT_MAX_LENGTH = 65_536;

export const PullRequestCommentInput = Schema.Struct({
  ...PullRequestRef.fields,
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(PULL_REQUEST_COMMENT_MAX_LENGTH)),
});
export type PullRequestCommentInput = typeof PullRequestCommentInput.Type;

/** The host reports the new comment's URL when it can; older CLIs print nothing. */
export const PullRequestCommentResult = Schema.Struct({
  url: Schema.NullOr(Schema.String),
});
export type PullRequestCommentResult = typeof PullRequestCommentResult.Type;

export const PullRequestActionInput = Schema.Struct({
  ...PullRequestRef.fields,
  action: PullRequestAction,
  /** Merge only; the repository's first allowed method when absent. */
  mergeMethod: Schema.optionalKey(PullRequestMergeMethod),
  /** `update-branch` only; the host's own default when absent. */
  updateMethod: Schema.optionalKey(PullRequestUpdateMethod),
  /** Merge only; leaves the head branch standing when absent. */
  deleteBranch: Schema.optionalKey(Schema.Boolean),
});
export type PullRequestActionInput = typeof PullRequestActionInput.Type;

/** The pull request as the host left it, read fresh after the action ran. */
export const PullRequestActionResult = Schema.Struct({
  state: PullRequestState,
  isDraft: Schema.Boolean,
});
export type PullRequestActionResult = typeof PullRequestActionResult.Type;

/**
 * Where a line comment hangs. A line the change added exists only in the new
 * file, a line it deleted only in the old one, and a context line in both — so
 * only a context line has a side to choose.
 */
export const PullRequestReviewPosition = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("added"), newLine: PositiveInt }),
  Schema.Struct({ kind: Schema.Literal("deleted"), oldLine: PositiveInt }),
  Schema.Struct({
    kind: Schema.Literal("context"),
    oldLine: PositiveInt,
    newLine: PositiveInt,
    side: PullRequestDiffSide,
  }),
]);
export type PullRequestReviewPosition = typeof PullRequestReviewPosition.Type;

/** One line comment held back until the whole review is sent. */
export const PullRequestReviewCommentDraft = Schema.Struct({
  path: TrimmedNonEmptyString,
  /** The path before a rename, where the host needs it to place a left-side line. */
  oldPath: Schema.optionalKey(TrimmedNonEmptyString),
  position: PullRequestReviewPosition,
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(PULL_REQUEST_COMMENT_MAX_LENGTH)),
});
export type PullRequestReviewCommentDraft = typeof PullRequestReviewCommentDraft.Type;

/** A body is required for `request-changes` and `comment`; an approval may be silent. */
export const PullRequestReviewInput = Schema.Struct({
  ...PullRequestRef.fields,
  verdict: PullRequestReviewVerdict,
  body: Schema.String.check(Schema.isMaxLength(PULL_REQUEST_COMMENT_MAX_LENGTH)),
  /** Empty for a verdict with no line comments, which is step 3's whole review. */
  comments: Schema.Array(PullRequestReviewCommentDraft),
});
export type PullRequestReviewInput = typeof PullRequestReviewInput.Type;

/** The host reports the new review's URL when it can; older CLIs print nothing. */
export const PullRequestReviewResult = Schema.Struct({
  url: Schema.NullOr(Schema.String),
});
export type PullRequestReviewResult = typeof PullRequestReviewResult.Type;

export const PullRequestThreadReplyInput = Schema.Struct({
  ...PullRequestRef.fields,
  threadId: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(PULL_REQUEST_COMMENT_MAX_LENGTH)),
});
export type PullRequestThreadReplyInput = typeof PullRequestThreadReplyInput.Type;

export const PullRequestThreadResolutionInput = Schema.Struct({
  ...PullRequestRef.fields,
  threadId: TrimmedNonEmptyString,
  resolved: Schema.Boolean,
});
export type PullRequestThreadResolutionInput = typeof PullRequestThreadResolutionInput.Type;

/** An absent `subjectId` reacts on the pull request's own description. */
export const PullRequestReactionInput = Schema.Struct({
  ...PullRequestRef.fields,
  subjectId: Schema.optionalKey(TrimmedNonEmptyString),
  content: PullRequestReactionContent,
  reacted: Schema.Boolean,
});
export type PullRequestReactionInput = typeof PullRequestReactionInput.Type;

/** At least one of `title` and `body`; the service refuses a request that names neither. */
export const PullRequestUpdateInput = Schema.Struct({
  ...PullRequestRef.fields,
  title: Schema.optionalKey(TrimmedNonEmptyString),
  body: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(PULL_REQUEST_COMMENT_MAX_LENGTH)),
  ),
});
export type PullRequestUpdateInput = typeof PullRequestUpdateInput.Type;

/** A conversation remark and a line remark are rewritten through different calls. */
export const PullRequestCommentUpdateKind = Schema.Literals(["issue-comment", "review-comment"]);
export type PullRequestCommentUpdateKind = typeof PullRequestCommentUpdateKind.Type;

export const PullRequestCommentUpdateInput = Schema.Struct({
  ...PullRequestRef.fields,
  commentId: TrimmedNonEmptyString,
  kind: PullRequestCommentUpdateKind,
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(PULL_REQUEST_COMMENT_MAX_LENGTH)),
});
export type PullRequestCommentUpdateInput = typeof PullRequestCommentUpdateInput.Type;

/** Someone the viewer may ask for a review, with an outstanding request marked. */
export const PullRequestReviewerCandidate = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: PullRequestReviewerKind,
  login: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  /** The host's picture for this candidate; null where it names none. */
  avatarUrl: Schema.NullOr(Schema.String),
  requested: Schema.Boolean,
});
export type PullRequestReviewerCandidate = typeof PullRequestReviewerCandidate.Type;

export const PullRequestReviewerCandidateList = Schema.Struct({
  candidates: Schema.Array(PullRequestReviewerCandidate),
});
export type PullRequestReviewerCandidateList = typeof PullRequestReviewerCandidateList.Type;

/** One call for both directions: asking for a review and taking the ask back. */
export const PullRequestReviewerRequestInput = Schema.Struct({
  ...PullRequestRef.fields,
  reviewers: Schema.Array(
    Schema.Struct({ id: TrimmedNonEmptyString, kind: PullRequestReviewerKind }),
  ),
  requested: Schema.Boolean,
});
export type PullRequestReviewerRequestInput = typeof PullRequestReviewerRequestInput.Type;
