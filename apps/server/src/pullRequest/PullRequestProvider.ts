import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  SourceControlProviderKind,
  type PullRequestAction,
  type PullRequestActor,
  type PullRequestActivity,
  type PullRequestBaseComparison,
  type PullRequestCapabilities,
  type PullRequestCheck,
  type PullRequestChecksState,
  type PullRequestCommentResult,
  type PullRequestCommentUpdateKind,
  type PullRequestDiffResult,
  type PullRequestLabel,
  type PullRequestListState,
  type PullRequestMergeability,
  type PullRequestMergeGate,
  type PullRequestMergeMethod,
  type PullRequestReactionContent,
  type PullRequestReviewCommentDraft,
  type PullRequestReviewDecision,
  type PullRequestReviewer,
  type PullRequestReviewerCandidateList,
  type PullRequestReviewerKind,
  type PullRequestReviewResult,
  type PullRequestReviewVerdict,
  type PullRequestState,
  type PullRequestUpdateMethod,
} from "@threadlines/contracts";

/**
 * The one failure shape every host reports through, so the service can decide
 * what a failure means without knowing which CLI or API produced it. `reason`
 * is the part the listing renders an action for.
 */
export class PullRequestProviderError extends Schema.TaggedError<PullRequestProviderError>()(
  "PullRequestProviderError",
  {
    provider: SourceControlProviderKind,
    operation: Schema.String,
    reason: Schema.Literals(["missing-tool", "unauthenticated", "rate-limited", "failed"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

/** Where a call runs, and which repository on the host it addresses. */
export interface ProviderRepositoryRef {
  /** A checkout the host's tool is run in; the credentials come with it. */
  readonly cwd: string;
  /**
   * Host-native repository identity: `owner/name` for GitHub and Bitbucket, the
   * whole group path for GitLab, and the repository's own name for Azure
   * DevOps, whose tool reads the rest from the checkout.
   */
  readonly repository: string;
}

/**
 * One change request as a listing carries it, before the service attaches the
 * project it belongs to and how it relates to the viewer.
 */
export interface ProviderChangeRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** When the row merged or closed; absent or null while open, or where the host did not say. */
  readonly settledAt?: string | null;
  /** Accounts with a review outstanding; team requests are dropped by each host. */
  readonly reviewRequestedLogins: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  /** Absent from a host that does not summarise its reviews. */
  readonly reviewDecision?: PullRequestReviewDecision;
  /**
   * Absent from a host a listing cannot ask about it without a request per row.
   * `unknown` is the host saying it has not finished checking.
   */
  readonly mergeability?: PullRequestMergeability;
  /** Absent where there are no checks, or where the listing did not ask for them. */
  readonly checksState?: PullRequestChecksState;
}

/**
 * One of the viewer's own change requests, found by searching the whole host
 * rather than by asking about a repository, so it names the one it is on.
 */
export interface ProviderAuthoredChangeRequest extends ProviderChangeRequest {
  /** Host-native repository identity, the same spelling a listing takes. */
  readonly repository: string;
  /**
   * Whether the viewer may push to that repository, where the search says so.
   * A workspace row learns the same thing from {@link ProviderRepositoryAccess};
   * a search covers repositories nobody here has checked out, so it has to
   * carry the answer itself. Absent where the host named no permission.
   */
  readonly viewerCanWrite?: boolean;
}

export interface ProviderChangeRequestDetail extends ProviderChangeRequest {
  readonly body: string;
  readonly changedFiles: number;
  readonly mergeability: PullRequestMergeability;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly reviewers: ReadonlyArray<PullRequestReviewer>;
  readonly checks: ReadonlyArray<PullRequestCheck>;
  /** Absent where the host does not say whether its rules would take a merge. */
  readonly mergeGate?: PullRequestMergeGate;
  readonly baseComparison: PullRequestBaseComparison;
  /** Null where the host could not compare the branch with its base. */
  readonly behindBy: number | null;
  /** Null where the host does not say whether it is armed to merge on its own. */
  readonly autoMergeEnabled: boolean | null;
}

/**
 * What the repository itself allows. Read once per repository and cached,
 * because it changes far more rarely than any pull request on it.
 */
export interface ProviderRepositoryAccess {
  readonly canWrite: boolean;
  readonly mergeMethods: ReadonlyArray<PullRequestMergeMethod>;
  /** What a pull request has to target not to be stacked on other work. */
  readonly defaultBranch: string | null;
}

/**
 * One host's pull requests. An implementation owns its own tool and JSON shapes
 * and answers with the neutral contract types; anything a host cannot do is
 * declared in `capabilities` rather than failing at call time.
 */
export interface PullRequestProviderApi {
  readonly kind: SourceControlProviderKind;
  /**
   * What this host supports in general. `mergeMethods` here is the host's whole
   * set; the service narrows it to what a repository allows before the detail
   * carries it.
   */
  readonly capabilities: PullRequestCapabilities;

  /** The signed-in account, or null when the host would not say. */
  readonly getViewer: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string | null, PullRequestProviderError>;

  readonly listChangeRequests: (
    input: ProviderRepositoryRef & {
      readonly state: PullRequestListState;
      readonly limit: number;
    },
  ) => Effect.Effect<ReadonlyArray<ProviderChangeRequest>, PullRequestProviderError>;

  /**
   * The viewer's own change requests anywhere on this host, including
   * repositories the workspace does not point at. Absent from a host with no
   * such search, whose listing is then only what the workspace covers. The
   * checkout is only where the tool runs; it does not narrow the answer.
   */
  readonly listAuthoredChangeRequests?: (input: {
    readonly cwd: string;
    readonly viewer: string;
    readonly state: PullRequestListState;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ProviderAuthoredChangeRequest>, PullRequestProviderError>;

  readonly getChangeRequest: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestDetail, PullRequestProviderError>;

  /** The conversation, the line threads, and the commits, read on their own. */
  readonly getChangeRequestActivity: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<PullRequestActivity, PullRequestProviderError>;

  /** Only called when `capabilities.diff` is true. */
  readonly getDiff: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<PullRequestDiffResult, PullRequestProviderError>;

  /** Only called for an action the host declared in `capabilities.actions`. */
  readonly runAction: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly action: PullRequestAction;
      /** Meaningful for `merge` and `enable-auto-merge`. */
      readonly mergeMethod?: PullRequestMergeMethod;
      /** Meaningful for `update-branch`; absent takes the host's own default. */
      readonly updateMethod?: PullRequestUpdateMethod;
      /** Meaningful for `merge`; leaves the head branch standing when absent. */
      readonly deleteBranch?: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /** Only called when `capabilities.comment` is true. */
  readonly comment: (
    input: ProviderRepositoryRef & { readonly number: number; readonly body: string },
  ) => Effect.Effect<PullRequestCommentResult, PullRequestProviderError>;

  /**
   * Sends a whole review at once, so nothing in it is visible to anyone else
   * before the verdict goes. Only called for a verdict the host declared, and
   * with line comments only where it declared `review.inlineComment`.
   */
  readonly submitReview: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    },
  ) => Effect.Effect<PullRequestReviewResult, PullRequestProviderError>;

  /** Only called when `capabilities.review.reply` is true. */
  readonly replyToThread: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly threadId: string;
      readonly body: string;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /** Only called when `capabilities.review.resolve` is true. */
  readonly setThreadResolution: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly threadId: string;
      readonly resolved: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * Adds a reaction or takes it back. An absent `subjectId` means the change
   * request's own description. The provider confirms a given subject belongs to
   * this pull request before it writes, so an id from elsewhere is refused.
   */
  readonly setReaction: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly subjectId?: string;
      readonly content: PullRequestReactionContent;
      readonly reacted: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /** Only called when `capabilities.edit.pullRequest` is true, never with both fields absent. */
  readonly updateChangeRequest: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly title?: string;
      readonly body?: string;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * Rewrites a remark. Whether it is the reader's to rewrite is the host's own
   * answer: access can be taken away between the read and the write.
   */
  readonly updateComment: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly commentId: string;
      readonly kind: PullRequestCommentUpdateKind;
      readonly body: string;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /** Only called when `capabilities.reviewers.listCandidates` is true. */
  readonly listReviewerCandidates: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<PullRequestReviewerCandidateList, PullRequestProviderError>;

  /**
   * Asks for a review or takes the ask back. One call for both directions,
   * because that is what every host does with them. Only called when
   * `capabilities.reviewers.request` is true.
   */
  readonly setReviewerRequest: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly reviewers: ReadonlyArray<{
        readonly id: string;
        readonly kind: PullRequestReviewerKind;
      }>;
      readonly requested: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly getRepositoryAccess: (
    input: ProviderRepositoryRef,
  ) => Effect.Effect<ProviderRepositoryAccess, PullRequestProviderError>;
}

export interface PullRequestProviderRegistryShape {
  /** Null for a host with no implementation, whose projects are skipped. */
  readonly get: (kind: SourceControlProviderKind) => PullRequestProviderApi | null;
}

export class PullRequestProviderRegistry extends Context.Service<
  PullRequestProviderRegistry,
  PullRequestProviderRegistryShape
>()("threadlines/pullRequest/PullRequestProviderRegistry") {}

/** Exported for tests, which stand a registry up from providers they supply themselves. */
export function fromProviders(
  providers: ReadonlyArray<PullRequestProviderApi>,
): PullRequestProviderRegistryShape {
  const byKind = new Map(providers.map((provider) => [provider.kind, provider]));
  return { get: (kind) => byKind.get(kind) ?? null };
}
