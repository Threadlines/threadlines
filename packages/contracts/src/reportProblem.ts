import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

/**
 * "Report a problem": the bug report written in the app, which the server
 * posts to GitHub from the person's own GitHub account (the one `gh` signs in
 * with). Limits keep the body well under GitHub's.
 */
export const REPORT_PROBLEM_LIMITS = {
  title: 200,
  text: 8_000,
  errorText: 20_000,
  version: 100,
  setup: 300,
} as const;

const boundedText = (maxLength: number) =>
  TrimmedNonEmptyString.check(Schema.isMaxLength(maxLength));

/**
 * Stays the same for one report across every try, so a retry after GitHub
 * didn't answer finds the issue the first try may have posted.
 */
export const ReportProblemSubmissionId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9-]{8,64}$/),
);
export type ReportProblemSubmissionId = typeof ReportProblemSubmissionId.Type;

/** Who would post the report: the account `gh` uses for github.com on that computer. */
export const ReportProblemAccount = Schema.Union([
  Schema.Struct({ status: Schema.Literal("signedIn"), login: TrimmedNonEmptyString }),
  Schema.Struct({ status: Schema.Literal("signedOut") }),
  Schema.Struct({ status: Schema.Literal("noGitHubCli") }),
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: TrimmedNonEmptyString }),
]);
export type ReportProblemAccount = typeof ReportProblemAccount.Type;

export const ReportProblemInput = Schema.Struct({
  submissionId: ReportProblemSubmissionId,
  /** The account the person saw; the server refuses to post as anyone else. */
  login: TrimmedNonEmptyString,
  title: boundedText(REPORT_PROBLEM_LIMITS.title),
  whatHappened: boundedText(REPORT_PROBLEM_LIMITS.text),
  steps: boundedText(REPORT_PROBLEM_LIMITS.text),
  expected: TrimmedString.check(Schema.isMaxLength(REPORT_PROBLEM_LIMITS.text)),
  errorText: Schema.String.check(Schema.isMaxLength(REPORT_PROBLEM_LIMITS.errorText)),
  version: boundedText(REPORT_PROBLEM_LIMITS.version),
  setup: boundedText(REPORT_PROBLEM_LIMITS.setup),
});
export type ReportProblemInput = typeof ReportProblemInput.Type;

export const ReportProblemResult = Schema.Struct({
  number: PositiveInt,
  url: TrimmedNonEmptyString,
});
export type ReportProblemResult = typeof ReportProblemResult.Type;

export class ReportProblemError extends Schema.TaggedError<ReportProblemError>()(
  "ReportProblemError",
  {
    /** What went wrong, in words for the person reporting. */
    reason: TrimmedNonEmptyString,
    /** GitHub may have posted it anyway; sending again checks for it first. */
    uncertain: Schema.Boolean,
  },
) {
  override get message(): string {
    return this.reason;
  }
}
