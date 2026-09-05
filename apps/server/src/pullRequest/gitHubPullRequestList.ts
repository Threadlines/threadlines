import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  type PullRequestActor,
  type PullRequestCheckStatus,
  type PullRequestChecksState,
  type PullRequestMergeability,
  type PullRequestReviewDecision,
  type PullRequestState,
} from "@threadlines/contracts";
import { decodeJsonResult, formatSchemaError } from "@threadlines/shared/schemaJson";

/**
 * The JSON fields the pull requests page asks `gh pr list` for.
 *
 * `statusCheckRollup` is expensive on large repositories, so it is only worth
 * paying for on the open listing, where the page renders a checks state.
 */
export const GITHUB_PULL_REQUEST_LIST_FIELDS = [
  "number",
  "title",
  "url",
  "author",
  "headRefName",
  "baseRefName",
  "state",
  "isDraft",
  "additions",
  "deletions",
  "createdAt",
  "updatedAt",
  "mergedAt",
  "mergeable",
  "reviewDecision",
  "reviewRequests",
  "labels",
] as const;

export const GITHUB_PULL_REQUEST_LIST_CHECKS_FIELD = "statusCheckRollup";

/** One decoded `gh pr list` row. Project and viewer context is added by the caller. */
export interface GitHubPullRequestListRow {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  /** `avatarUrl` is null until the provider resolves it; `gh` reports none. */
  readonly author: PullRequestActor | null;
  /**
   * The author's node id, which is how an account whose picture cannot be
   * derived from its login is looked up. Null where the host named none.
   */
  readonly authorId: string | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** User logins with a pending review request; team requests are dropped. */
  readonly reviewRequestedLogins: ReadonlyArray<string>;
  readonly reviewDecision?: PullRequestReviewDecision;
  readonly checksState?: PullRequestChecksState;
  /** Absent where the host said nothing about whether the branch still merges. */
  readonly mergeability?: PullRequestMergeability;
  readonly labels: ReadonlyArray<{ readonly name: string; readonly color: string | null }>;
}

export const GitHubAuthorSchema = Schema.Struct({
  login: Schema.String,
  is_bot: Schema.optional(Schema.NullOr(Schema.Boolean)),
  isBot: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /** The node id `gh` reports beside a login, and GraphQL looks an account up by. */
  id: Schema.optional(Schema.NullOr(Schema.String)),
  /** GraphQL selects it; `gh pr list --json author` never carries one. */
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubLabelSchema = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubReviewRequestSchema = Schema.Struct({
  __typename: Schema.optional(Schema.NullOr(Schema.String)),
  login: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * One `statusCheckRollup` entry. `gh` reports check runs (`name`, `status`,
 * `conclusion`, `detailsUrl`) and legacy commit statuses (`context`, `state`,
 * `targetUrl`) side by side in the same array.
 */
export const GitHubStatusCheckSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  detailsUrl: Schema.optional(Schema.NullOr(Schema.String)),
  targetUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

export const GitHubPullRequestListRowSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.optional(Schema.NullOr(GitHubAuthorSchema)),
  headRefName: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  additions: Schema.optional(Schema.NullOr(NonNegativeInt)),
  deletions: Schema.optional(Schema.NullOr(NonNegativeInt)),
  createdAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  reviewRequests: Schema.optional(Schema.NullOr(Schema.Array(GitHubReviewRequestSchema))),
  labels: Schema.optional(Schema.NullOr(Schema.Array(GitHubLabelSchema))),
  statusCheckRollup: Schema.optional(Schema.NullOr(Schema.Array(GitHubStatusCheckSchema))),
});

const FAILING_CHECK_CONCLUSIONS = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const PASSING_CHECK_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const NOT_RUN_CHECK_CONCLUSIONS = new Set(["SKIPPED", "NEUTRAL"]);

/** Trims a host string and reports "the host left this out" as null. */
export function nonEmptyText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The `PullRequestActor` behind a `gh` author object, or null when unnamed.
 * `avatarUrl` is whatever the payload carried: GraphQL selects one, while
 * `gh pr view --json` reports none and leaves the picture to be resolved.
 */
export function normalizeActor(
  raw: Schema.Schema.Type<typeof GitHubAuthorSchema> | null | undefined,
): PullRequestActor | null {
  const login = nonEmptyText(raw?.login);
  return login === null
    ? null
    : {
        login,
        isBot: raw?.is_bot === true || raw?.isBot === true,
        avatarUrl: nonEmptyText(raw?.avatarUrl),
      };
}

/** The node id beside a `gh` author, which is what an avatar lookup addresses. */
export function actorNodeId(
  raw: Schema.Schema.Type<typeof GitHubAuthorSchema> | null | undefined,
): string | null {
  return nonEmptyText(raw?.id);
}

/** How GitHub says a branch stands against its base, in the contract's words. */
export function normalizeMergeability(
  value: string | null | undefined,
): PullRequestMergeability | undefined {
  switch (value?.trim().toUpperCase()) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    case "UNKNOWN":
      return "unknown";
    default:
      return undefined;
  }
}

function normalizeState(raw: {
  readonly state?: string | null | undefined;
  readonly mergedAt?: string | null | undefined;
}): PullRequestState {
  const state = raw.state?.trim().toUpperCase();
  if (nonEmptyText(raw.mergedAt) !== null || state === "MERGED") {
    return "merged";
  }
  return state === "CLOSED" ? "closed" : "open";
}

function normalizeReviewDecision(
  value: string | null | undefined,
): PullRequestReviewDecision | undefined {
  switch (value?.trim().toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "REVIEW_REQUIRED":
      return "review-required";
    default:
      return undefined;
  }
}

/**
 * One check's own verdict. Check runs report `status` plus `conclusion`, legacy
 * commit statuses only a `state`, so a run with no status is judged by whether
 * its conclusion is a terminal one.
 */
export function normalizeCheckStatus(
  check: Schema.Schema.Type<typeof GitHubStatusCheckSchema>,
): PullRequestCheckStatus {
  const conclusion = (
    nonEmptyText(check.conclusion) ??
    nonEmptyText(check.state) ??
    ""
  ).toUpperCase();
  if (FAILING_CHECK_CONCLUSIONS.has(conclusion)) {
    return "failure";
  }

  const status = (nonEmptyText(check.status) ?? "").toUpperCase();
  const completed =
    status.length > 0 ? status === "COMPLETED" : PASSING_CHECK_CONCLUSIONS.has(conclusion);
  if (!completed) {
    return "pending";
  }

  return NOT_RUN_CHECK_CONCLUSIONS.has(conclusion) ? "skipped" : "success";
}

/**
 * Collapses `gh`'s per-check rollup into the one word the row renders. A check
 * that has not completed outranks the passing checks around it, and any hard
 * failure outranks everything; a skipped check is nobody's problem.
 */
function normalizeChecksState(
  checks: ReadonlyArray<Schema.Schema.Type<typeof GitHubStatusCheckSchema>> | null | undefined,
): PullRequestChecksState | undefined {
  if (!checks || checks.length === 0) {
    return undefined;
  }

  let pending = false;
  for (const check of checks) {
    const status = normalizeCheckStatus(check);
    if (status === "failure") {
      return "failure";
    }
    if (status === "pending") {
      pending = true;
    }
  }

  return pending ? "pending" : "success";
}

export function normalizeGitHubPullRequestListRow(
  raw: Schema.Schema.Type<typeof GitHubPullRequestListRowSchema>,
): GitHubPullRequestListRow {
  const reviewDecision = normalizeReviewDecision(raw.reviewDecision);
  const checksState = normalizeChecksState(raw.statusCheckRollup);
  const mergeability = normalizeMergeability(raw.mergeable);

  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: normalizeActor(raw.author),
    authorId: actorNodeId(raw.author),
    headBranch: raw.headRefName,
    baseBranch: raw.baseRefName,
    state: normalizeState(raw),
    isDraft: raw.isDraft === true,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    reviewRequestedLogins: (raw.reviewRequests ?? []).flatMap((request) => {
      const typename = nonEmptyText(request.__typename);
      if (typename !== null && typename !== "User") {
        return [];
      }
      const login = nonEmptyText(request.login);
      return login === null ? [] : [login];
    }),
    ...(reviewDecision === undefined ? {} : { reviewDecision }),
    ...(checksState === undefined ? {} : { checksState }),
    ...(mergeability === undefined ? {} : { mergeability }),
    labels: (raw.labels ?? []).flatMap((label) => {
      const name = nonEmptyText(label.name);
      return name === null ? [] : [{ name, color: nonEmptyText(label.color) }];
    }),
  };
}

const decodePayload = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeRow = Schema.decodeUnknownExit(GitHubPullRequestListRowSchema);

export const formatGitHubPullRequestListDecodeError = formatSchemaError;

/**
 * One row in the shape `gh pr list --json` reports, or null when it is not in a
 * shape we can use. The authored search reads through here too: its GraphQL
 * nodes are reshaped into this and then decoded, so both listings normalise a
 * state, a review decision and a check rollup exactly the same way.
 */
export function decodeGitHubPullRequestListRow(entry: unknown): GitHubPullRequestListRow | null {
  const decoded = decodeRow(entry);
  return Exit.isFailure(decoded) ? null : normalizeGitHubPullRequestListRow(decoded.value);
}

/**
 * Decodes `gh pr list --json` output. A row `gh` reports in a shape we cannot
 * use is dropped so one odd pull request never hides the rest; only a payload
 * that is not a JSON array fails.
 */
export function decodeGitHubPullRequestListJson(
  raw: string,
): Result.Result<ReadonlyArray<GitHubPullRequestListRow>, Cause.Cause<Schema.SchemaError>> {
  const payload = decodePayload(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }

  const rows: GitHubPullRequestListRow[] = [];
  for (const entry of payload.success) {
    const row = decodeGitHubPullRequestListRow(entry);
    if (row !== null) {
      rows.push(row);
    }
  }
  return Result.succeed(rows);
}
