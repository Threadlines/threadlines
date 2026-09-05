import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  TrimmedNonEmptyString,
  type PullRequestCheck,
  type PullRequestComment,
  type PullRequestCommit,
  type PullRequestMergeability,
  type PullRequestMergeGate,
  type PullRequestMergeMethod,
  type PullRequestReviewer,
  type PullRequestReviewState,
} from "@threadlines/contracts";
import { decodeJsonResult } from "@threadlines/shared/schemaJson";

import {
  GITHUB_PULL_REQUEST_LIST_CHECKS_FIELD,
  GITHUB_PULL_REQUEST_LIST_FIELDS,
  GitHubAuthorSchema,
  GitHubPullRequestListRowSchema,
  GitHubStatusCheckSchema,
  nonEmptyText,
  normalizeActor,
  normalizeCheckStatus,
  normalizeGitHubPullRequestListRow,
  normalizeMergeability,
  type GitHubPullRequestListRow,
} from "./gitHubPullRequestList.ts";

/**
 * `gh pr view --json` fields for the detail header. The list fields carry the
 * shared shape; the rest is what only the detail surface renders.
 */
export const GITHUB_PULL_REQUEST_DETAIL_FIELDS = [
  ...GITHUB_PULL_REQUEST_LIST_FIELDS,
  GITHUB_PULL_REQUEST_LIST_CHECKS_FIELD,
  "body",
  "changedFiles",
  "closedAt",
  "reviews",
  "autoMergeRequest",
  // What `gh pr merge` itself consults before it tries: the host's verdict on
  // whether its rules would take the merge.
  "mergeStateStatus",
  // Qualifies the head branch as `owner:branch`, which is the only name a
  // branch on a fork has in the base repository.
  "headRepositoryOwner",
] as const;

/** `gh pr view --json` fields for the conversation below the header. */
export const GITHUB_PULL_REQUEST_ACTIVITY_FIELDS = ["comments", "reviews", "commits"] as const;

/** What the repository itself allows: the viewer's access and the merge buttons. */
export interface GitHubRepositoryAccess {
  readonly canWrite: boolean;
  readonly mergeMethods: ReadonlyArray<PullRequestMergeMethod>;
  /** What a pull request has to target not to be stacked on other work. */
  readonly defaultBranch: string | null;
  /** Absent on a host too old to report the auto-merge switch. */
  readonly autoMergeAllowed?: boolean;
}

/** The order the detail surface offers the allowed merge methods in. */
const MERGE_METHOD_ORDER = [
  "merge",
  "squash",
  "rebase",
] as const satisfies ReadonlyArray<PullRequestMergeMethod>;

/**
 * The REST repository record, picked down to what an action needs. `gh api`
 * answers with the whole record and the picking happens here rather than in a
 * `--jq` expression, so the mapping is the part under test.
 */
const GitHubRepositorySchema = Schema.Struct({
  permissions: Schema.optional(
    Schema.NullOr(Schema.Struct({ push: Schema.optional(Schema.NullOr(Schema.Boolean)) })),
  ),
  allow_merge_commit: Schema.optional(Schema.NullOr(Schema.Boolean)),
  allow_squash_merge: Schema.optional(Schema.NullOr(Schema.Boolean)),
  allow_rebase_merge: Schema.optional(Schema.NullOr(Schema.Boolean)),
  allow_auto_merge: Schema.optional(Schema.NullOr(Schema.Boolean)),
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * `gh pr view --json mergeStateStatus`: the one word GitHub sums a pull
 * request's readiness into.
 */
const GitHubMergeStateSchema = Schema.Struct({
  mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * The states `gh pr merge --auto` merges outright instead of arming, copied
 * from the CLI: nothing is pending, so there is nothing to wait for.
 */
const IMMEDIATELY_MERGEABLE_STATES = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

/** A `gh pr view` row: everything a list row carries, plus the detail fields. */
export interface GitHubPullRequestDetailRow extends GitHubPullRequestListRow {
  readonly body: string;
  readonly changedFiles: number;
  readonly mergeability: PullRequestMergeability;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly reviewers: ReadonlyArray<PullRequestReviewer>;
  readonly checks: ReadonlyArray<PullRequestCheck>;
  /** Absent while the host is still deciding after a push, or on a host too old to say. */
  readonly mergeGate?: PullRequestMergeGate;
  /** Qualifies the head branch when it lives on a fork. */
  readonly headRepositoryOwnerLogin: string | null;
}

/** The conversation half of a `gh pr view` read, before GraphQL decorates it. */
export interface GitHubPullRequestActivityRow {
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly commits: ReadonlyArray<PullRequestCommit>;
}

/** Reviews carry `submittedAt` rather than the `createdAt` comments use. */
const GitHubReviewSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(GitHubAuthorSchema)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  submittedAt: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubIssueCommentSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(GitHubAuthorSchema)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubCommitSchema = Schema.Struct({
  oid: TrimmedNonEmptyString,
  messageHeadline: Schema.optional(Schema.NullOr(Schema.String)),
  committedDate: Schema.optional(Schema.NullOr(Schema.String)),
  authors: Schema.optional(
    Schema.NullOr(
      Schema.Array(Schema.Struct({ login: Schema.optional(Schema.NullOr(Schema.String)) })),
    ),
  ),
});

const GitHubPullRequestDetailRowSchema = Schema.Struct({
  ...GitHubPullRequestListRowSchema.fields,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  changedFiles: Schema.optional(Schema.NullOr(NonNegativeInt)),
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  reviews: Schema.optional(Schema.NullOr(Schema.Array(GitHubReviewSchema))),
  /** An object while auto-merge is armed, null once it is not, absent on an older CLI. */
  autoMergeRequest: Schema.optional(Schema.NullOr(Schema.Struct({}))),
  mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
  headRepositoryOwner: Schema.optional(
    Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

const GitHubPullRequestActivitySchema = Schema.Struct({
  comments: Schema.optional(Schema.NullOr(Schema.Array(GitHubIssueCommentSchema))),
  reviews: Schema.optional(Schema.NullOr(Schema.Array(GitHubReviewSchema))),
  commits: Schema.optional(Schema.NullOr(Schema.Array(GitHubCommitSchema))),
});

type GitHubReview = Schema.Schema.Type<typeof GitHubReviewSchema>;

/** Verdicts that stand on their own; `COMMENTED` needs a body to be worth showing. */
const STANDALONE_REVIEW_STATES = new Set<PullRequestReviewState>([
  "approved",
  "changes-requested",
  "dismissed",
]);

function normalizeReviewState(value: string | null | undefined): PullRequestReviewState | null {
  switch (value?.trim().toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "DISMISSED":
      return "dismissed";
    case "COMMENTED":
      return "commented";
    default:
      return null;
  }
}

/**
 * Requested users come first as `pending`: a fresh request outranks the verdict
 * that triggered it. Otherwise a reviewer carries their latest verdict; a
 * plain comment after a verdict leaves the verdict standing, which is how the
 * host itself reports the reviewer. The pull request's own author is never
 * listed as its reviewer.
 */
function normalizeReviewers(input: {
  readonly authorLogin: string | null;
  readonly reviewRequestedLogins: ReadonlyArray<string>;
  readonly reviews: ReadonlyArray<GitHubReview>;
}): ReadonlyArray<PullRequestReviewer> {
  const excluded = input.authorLogin?.toLowerCase() ?? null;
  const requested = new Map<string, PullRequestReviewer>();
  for (const login of input.reviewRequestedLogins) {
    const key = login.toLowerCase();
    if (key !== excluded) {
      // A GitHub user is addressed by their login; team requests never reach
      // here. `gh pr view --json` names no picture, so the provider fills it.
      requested.set(key, { id: login, kind: "user", login, state: "pending", avatarUrl: null });
    }
  }

  const reviewed = new Map<string, PullRequestReviewer>();
  for (const review of input.reviews) {
    const login = nonEmptyText(review.author?.login);
    const state = normalizeReviewState(review.state);
    if (login === null || state === null) {
      continue;
    }
    const key = login.toLowerCase();
    if (key === excluded || requested.has(key)) {
      continue;
    }
    const previous = reviewed.get(key);
    if (state === "commented" && previous !== undefined && previous.state !== "commented") {
      continue;
    }
    reviewed.set(key, {
      id: login,
      kind: "user",
      login,
      state,
      avatarUrl: normalizeActor(review.author)?.avatarUrl ?? null,
    });
  }

  return [...requested.values(), ...reviewed.values()];
}

/** One row per check. A repeated name is a re-run, so the last one wins. */
/**
 * GitHub's `mergeStateStatus` as the gate the client renders. `BLOCKED` and
 * `BEHIND` are the two `gh pr merge` refuses on without `--admin`; `DIRTY` is a
 * conflict and already told through `mergeability`, and `UNKNOWN` is a host
 * that has not finished deciding, so both say nothing here.
 */
function normalizeMergeGate(value: string | null | undefined): PullRequestMergeGate | undefined {
  switch (value?.trim().toUpperCase()) {
    case "BLOCKED":
      return "blocked";
    case "BEHIND":
      return "behind";
    case "CLEAN":
    case "HAS_HOOKS":
    case "UNSTABLE":
      return "clear";
    default:
      return undefined;
  }
}

function normalizeChecks(
  checks: ReadonlyArray<Schema.Schema.Type<typeof GitHubStatusCheckSchema>> | null | undefined,
): ReadonlyArray<PullRequestCheck> {
  const byName = new Map<string, PullRequestCheck>();
  for (const check of checks ?? []) {
    const name = nonEmptyText(check.name) ?? nonEmptyText(check.context);
    if (name === null) {
      continue;
    }
    byName.set(name, {
      name,
      status: normalizeCheckStatus(check),
      description: nonEmptyText(check.description),
      url: nonEmptyText(check.detailsUrl) ?? nonEmptyText(check.targetUrl),
    });
  }
  return [...byName.values()];
}

function toComment(input: {
  readonly kind: PullRequestComment["kind"];
  readonly id: string | null;
  readonly author: Schema.Schema.Type<typeof GitHubAuthorSchema> | null | undefined;
  readonly body: string | null;
  readonly createdAt: string;
  readonly url: string | null;
  readonly reviewState: PullRequestReviewState | null;
}): PullRequestComment {
  return {
    // `gh` always sends node ids, but a comment is still worth rendering
    // without one; the url or the timestamp keeps the row keyed.
    id: input.id ?? input.url ?? `${input.kind}-${input.createdAt}`,
    kind: input.kind,
    author: normalizeActor(input.author),
    body: input.body ?? "",
    createdAt: input.createdAt,
    url: input.url,
    reviewState: input.reviewState,
    // `gh pr view --json` reports neither; the activity read's own GraphQL
    // document fills both in by node id.
    reactions: [],
    viewerIsAuthor: false,
  };
}

function normalizeComments(
  raw: Schema.Schema.Type<typeof GitHubPullRequestActivitySchema>,
): ReadonlyArray<PullRequestComment> {
  const comments: PullRequestComment[] = [];

  for (const comment of raw.comments ?? []) {
    const createdAt = nonEmptyText(comment.createdAt);
    if (createdAt === null) {
      continue;
    }
    comments.push(
      toComment({
        kind: "issue-comment",
        id: nonEmptyText(comment.id),
        author: comment.author,
        body: comment.body ?? "",
        createdAt,
        url: nonEmptyText(comment.url),
        reviewState: null,
      }),
    );
  }

  for (const review of raw.reviews ?? []) {
    const createdAt = nonEmptyText(review.submittedAt) ?? nonEmptyText(review.createdAt);
    if (createdAt === null) {
      continue;
    }
    const body = review.body ?? "";
    const reviewState = normalizeReviewState(review.state);
    // A bodiless `COMMENTED` review is GitHub's container for line comments,
    // which the summary does not render; a bodiless verdict still counts.
    const carriesVerdict = reviewState !== null && STANDALONE_REVIEW_STATES.has(reviewState);
    if (body.trim().length === 0 && !carriesVerdict) {
      continue;
    }
    comments.push(
      toComment({
        kind: "review",
        id: nonEmptyText(review.id),
        author: review.author,
        body,
        createdAt,
        url: nonEmptyText(review.url),
        reviewState,
      }),
    );
  }

  // ISO timestamps sort lexicographically; equal ones keep the host's order.
  return comments.sort((left, right) =>
    left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0,
  );
}

function normalizeCommits(
  raw: Schema.Schema.Type<typeof GitHubPullRequestActivitySchema>,
): ReadonlyArray<PullRequestCommit> {
  return (raw.commits ?? []).flatMap((commit) => {
    const committedDate = nonEmptyText(commit.committedDate);
    if (committedDate === null) {
      return [];
    }
    return [
      {
        oid: commit.oid,
        messageHeadline: commit.messageHeadline ?? "",
        committedDate,
        authorLogin: nonEmptyText(commit.authors?.[0]?.login),
      } satisfies PullRequestCommit,
    ];
  });
}

const decodeDetailPayload = decodeJsonResult(GitHubPullRequestDetailRowSchema);
const decodeActivityPayload = decodeJsonResult(GitHubPullRequestActivitySchema);
const decodeRepositoryPayload = decodeJsonResult(GitHubRepositorySchema);
const decodeMergeStatePayload = decodeJsonResult(GitHubMergeStateSchema);

/**
 * Decodes `gh api repos/<owner>/<name>` into the viewer's access and the merge
 * methods the repository allows. No `permissions` object means no push access.
 * A host that reports none of the three switches is not forbidding anything, so
 * all three are offered and the host still refuses what it does not allow.
 */
export function decodeGitHubRepositoryJson(
  raw: string,
): Result.Result<GitHubRepositoryAccess, Cause.Cause<Schema.SchemaError>> {
  const payload = decodeRepositoryPayload(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }

  const row = payload.success;
  const switches = [row.allow_merge_commit, row.allow_squash_merge, row.allow_rebase_merge];
  const reported = switches.some((value) => value !== undefined && value !== null);

  return Result.succeed({
    canWrite: row.permissions?.push === true,
    mergeMethods: MERGE_METHOD_ORDER.filter(
      (_method, index) => !reported || switches[index] === true,
    ),
    defaultBranch: nonEmptyText(row.default_branch),
    ...(typeof row.allow_auto_merge === "boolean"
      ? { autoMergeAllowed: row.allow_auto_merge }
      : {}),
  });
}

/**
 * Whether GitHub would merge the pull request this instant, read from
 * `gh pr view --json mergeStateStatus`. A status the host did not name is not
 * ready: arming then waits, which is the safe way to be wrong.
 */
export function decodeGitHubImmediatelyMergeableJson(
  raw: string,
): Result.Result<boolean, Cause.Cause<Schema.SchemaError>> {
  const payload = decodeMergeStatePayload(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  const status = nonEmptyText(payload.success.mergeStateStatus);
  return Result.succeed(status !== null && IMMEDIATELY_MERGEABLE_STATES.has(status));
}

/** Decodes `gh pr view --json <detail fields>` into the header the panel renders. */
export function decodeGitHubPullRequestDetailJson(
  raw: string,
): Result.Result<GitHubPullRequestDetailRow, Cause.Cause<Schema.SchemaError>> {
  const payload = decodeDetailPayload(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }

  const row = payload.success;
  const base = normalizeGitHubPullRequestListRow(row);
  const mergeGate = normalizeMergeGate(row.mergeStateStatus);
  return Result.succeed({
    ...base,
    body: row.body ?? "",
    changedFiles: row.changedFiles ?? 0,
    // A host that has not finished its check says nothing, which the detail
    // renders as "unknown" rather than leaving the field out.
    mergeability: normalizeMergeability(row.mergeable) ?? "unknown",
    mergedAt: nonEmptyText(row.mergedAt),
    closedAt: nonEmptyText(row.closedAt),
    reviewers: normalizeReviewers({
      authorLogin: base.author?.login ?? null,
      reviewRequestedLogins: base.reviewRequestedLogins,
      reviews: row.reviews ?? [],
    }),
    checks: normalizeChecks(row.statusCheckRollup),
    ...(mergeGate === undefined ? {} : { mergeGate }),
    headRepositoryOwnerLogin: nonEmptyText(row.headRepositoryOwner?.login),
  });
}

/** Decodes `gh pr view --json comments,reviews,commits` into one ordered conversation. */
export function decodeGitHubPullRequestActivityJson(
  raw: string,
): Result.Result<GitHubPullRequestActivityRow, Cause.Cause<Schema.SchemaError>> {
  const payload = decodeActivityPayload(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }

  return Result.succeed({
    comments: normalizeComments(payload.success),
    commits: normalizeCommits(payload.success),
  });
}
