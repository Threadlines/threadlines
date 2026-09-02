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

export const PullRequestActor = Schema.Struct({
  login: TrimmedNonEmptyString,
  isBot: Schema.Boolean,
});
export type PullRequestActor = typeof PullRequestActor.Type;

/** `color` is the hex triplet without a leading `#`, exactly as the host reports it. */
export const PullRequestLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.NullOr(Schema.String),
});
export type PullRequestLabel = typeof PullRequestLabel.Type;

/**
 * One pull request as the pull requests page renders it: the host's fields plus
 * the project it belongs to and how it relates to the signed-in viewer.
 */
export const PullRequestListEntry = Schema.Struct({
  provider: SourceControlProviderKind,
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
  viewerIsAuthor: Schema.Boolean,
  viewerReviewRequested: Schema.Boolean,
  /** Absent when the host reports no decision. */
  reviewDecision: Schema.optionalKey(PullRequestReviewDecision),
  /** Absent when there are no checks, or when checks were not requested. */
  checksState: Schema.optionalKey(PullRequestChecksState),
  labels: Schema.Array(PullRequestLabel),
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
