import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  type PullRequestChecksState,
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
  readonly author: { readonly login: string; readonly isBot: boolean } | null;
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
  readonly labels: ReadonlyArray<{ readonly name: string; readonly color: string | null }>;
}

const GitHubAuthorSchema = Schema.Struct({
  login: Schema.String,
  is_bot: Schema.optional(Schema.NullOr(Schema.Boolean)),
  isBot: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const GitHubLabelSchema = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubReviewRequestSchema = Schema.Struct({
  __typename: Schema.optional(Schema.NullOr(Schema.String)),
  login: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubStatusCheckSchema = Schema.Struct({
  status: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubPullRequestListRowSchema = Schema.Struct({
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

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeState(raw: {
  readonly state?: string | null | undefined;
  readonly mergedAt?: string | null | undefined;
}): PullRequestState {
  const state = raw.state?.trim().toUpperCase();
  if (nonEmpty(raw.mergedAt) !== null || state === "MERGED") {
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
 * Collapses `gh`'s per-check rollup into the one word the row renders. A check
 * that has not completed outranks the passing checks around it, and any hard
 * failure outranks everything.
 */
function normalizeChecksState(
  checks: ReadonlyArray<Schema.Schema.Type<typeof GitHubStatusCheckSchema>> | null | undefined,
): PullRequestChecksState | undefined {
  if (!checks || checks.length === 0) {
    return undefined;
  }

  let pending = false;
  for (const check of checks) {
    const conclusion = (nonEmpty(check.conclusion) ?? nonEmpty(check.state) ?? "").toUpperCase();
    if (FAILING_CHECK_CONCLUSIONS.has(conclusion)) {
      return "failure";
    }

    const status = (nonEmpty(check.status) ?? "").toUpperCase();
    const completed =
      status.length > 0 ? status === "COMPLETED" : PASSING_CHECK_CONCLUSIONS.has(conclusion);
    if (!completed) {
      pending = true;
    }
  }

  return pending ? "pending" : "success";
}

function normalizeRow(
  raw: Schema.Schema.Type<typeof GitHubPullRequestListRowSchema>,
): GitHubPullRequestListRow {
  const authorLogin = nonEmpty(raw.author?.login);
  const reviewDecision = normalizeReviewDecision(raw.reviewDecision);
  const checksState = normalizeChecksState(raw.statusCheckRollup);

  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author:
      authorLogin === null
        ? null
        : { login: authorLogin, isBot: raw.author?.is_bot === true || raw.author?.isBot === true },
    headBranch: raw.headRefName,
    baseBranch: raw.baseRefName,
    state: normalizeState(raw),
    isDraft: raw.isDraft === true,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    reviewRequestedLogins: (raw.reviewRequests ?? []).flatMap((request) => {
      const typename = nonEmpty(request.__typename);
      if (typename !== null && typename !== "User") {
        return [];
      }
      const login = nonEmpty(request.login);
      return login === null ? [] : [login];
    }),
    ...(reviewDecision === undefined ? {} : { reviewDecision }),
    ...(checksState === undefined ? {} : { checksState }),
    labels: (raw.labels ?? []).flatMap((label) => {
      const name = nonEmpty(label.name);
      return name === null ? [] : [{ name, color: nonEmpty(label.color) }];
    }),
  };
}

const decodePayload = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeRow = Schema.decodeUnknownExit(GitHubPullRequestListRowSchema);

export const formatGitHubPullRequestListDecodeError = formatSchemaError;

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
    const decoded = decodeRow(entry);
    if (Exit.isFailure(decoded)) {
      continue;
    }
    rows.push(normalizeRow(decoded.value));
  }
  return Result.succeed(rows);
}
