/**
 * "Report a problem": posts the bug report a person wrote in the app to
 * Threadlines' GitHub issues, from their own GitHub account (the one `gh` uses
 * for github.com on this computer). There is no bot and no key of ours: an
 * issue is the person's, and GitHub tells them when someone replies.
 *
 * A post that GitHub may have taken without answering (a timeout, a dropped
 * connection) is never repeated blind. Every report carries its submission id
 * in a hidden line, and before every post the service looks for that line
 * among the person's newest issues; when it can't look, it doesn't post.
 */
import * as NodeOS from "node:os";

import {
  type ReportProblemAccount,
  ReportProblemError,
  type ReportProblemInput,
  type ReportProblemResult,
} from "@threadlines/contracts";
import {
  buildReportIssueBody,
  reportIssueMarker,
  reportIssueTitle,
  THREADLINES_REPOSITORY,
} from "@threadlines/shared/reportIssue";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { GitHubCli, GitHubCliError, gitHubFailureKind as failureKind } from "./GitHubCli.ts";

const GITHUB_HOST = "github.com";
const LOOKUP_TIMEOUT_MS = 15_000;
const POST_TIMEOUT_MS = 30_000;
/**
 * How many of the person's newest issues a look covers: GitHub's largest page.
 * A report posted further back than that is not looked for.
 */
const RECENT_ISSUES_CHECKED = 100;

export interface ProblemReportsShape {
  /** Who a report would be posted as, read from GitHub each time. */
  readonly account: Effect.Effect<ReportProblemAccount>;
  readonly submit: (
    input: ReportProblemInput,
  ) => Effect.Effect<ReportProblemResult, ReportProblemError>;
}

export class ProblemReports extends Context.Service<ProblemReports, ProblemReportsShape>()(
  "threadlines/source-control/ProblemReports",
) {}

const PostedIssue = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
});
const decodePostedIssue = Schema.decodeUnknownOption(Schema.fromJsonString(PostedIssue));

const decodeFoundIssues = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(PostedIssue)),
);

const refuse = (reason: string) => new ReportProblemError({ reason, uncertain: false });

const REASONS = {
  noGitHubCli:
    "Posting from Threadlines needs the GitHub command-line tool (gh) on this computer. Open it on GitHub instead.",
  signedOut: "This computer isn't signed in to GitHub. Sign in, then post again.",
  rateLimited: "GitHub is limiting requests right now. Try again in a few minutes.",
  rejected: "GitHub didn't accept the report. Open it on GitHub instead.",
  unreachable: "Couldn't reach GitHub. Check your connection and try again.",
  uncertain:
    "GitHub didn't answer in time, so the report may have posted anyway. Posting again checks for it first.",
} as const;

function accountAfterFailure(error: GitHubCliError): ReportProblemAccount {
  switch (failureKind(error)) {
    case "noGitHubCli":
      return { status: "noGitHubCli" };
    case "signedOut":
      return { status: "signedOut" };
    case "rateLimited":
      return { status: "unavailable", reason: REASONS.rateLimited };
    default:
      return { status: "unavailable", reason: REASONS.unreachable };
  }
}

export const make = Effect.fn("makeProblemReports")(function* () {
  const github = yield* GitHubCli;
  const lock = yield* Semaphore.make(1);
  const cwd = NodeOS.homedir();
  /** Reports posted since the server started, by submission id. */
  const posted = new Map<string, ReportProblemResult>();
  /** Submission ids whose post GitHub may have taken without saying so. */
  const unsettled = new Set<string>();

  const gh = (args: ReadonlyArray<string>, options: { timeoutMs: number; stdin?: string }) =>
    github.execute({
      cwd,
      args: ["api", "--hostname", GITHUB_HOST, ...args],
      timeoutMs: options.timeoutMs,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    });

  const currentLogin = gh(["user", "--jq", ".login"], { timeoutMs: LOOKUP_TIMEOUT_MS }).pipe(
    Effect.map((result) => result.stdout.trim()),
  );

  const account: ProblemReportsShape["account"] = currentLogin.pipe(
    Effect.map((login): ReportProblemAccount =>
      login.length > 0
        ? { status: "signedIn", login }
        : { status: "unavailable", reason: REASONS.unreachable },
    ),
    Effect.catch((error) => Effect.succeed(accountAfterFailure(error))),
  );

  /**
   * The person's recent issue carrying this submission's hidden line, if
   * GitHub has it. `gh` filters the list itself, so the answer stays small;
   * an answer that can't be read fails rather than passing for "not there".
   */
  const findPosted = (login: string, submissionId: string) =>
    gh(
      [
        `repos/${THREADLINES_REPOSITORY}/issues?creator=${encodeURIComponent(login)}&state=all&sort=created&direction=desc&per_page=${RECENT_ISSUES_CHECKED}`,
        "--jq",
        // The id is letters, digits and dashes (ReportProblemSubmissionId), so the marker is a safe jq string.
        `map(select((.body // "") | contains(${JSON.stringify(reportIssueMarker(submissionId))})) | {number, url: .html_url})`,
      ],
      { timeoutMs: LOOKUP_TIMEOUT_MS },
    ).pipe(
      Effect.flatMap((result) =>
        Option.match(decodeFoundIssues(result.stdout), {
          onNone: () =>
            Effect.fail(
              new GitHubCliError({
                operation: "findPosted",
                detail: "GitHub's list of issues couldn't be read.",
              }),
            ),
          onSome: (issues) =>
            Effect.succeed(
              Option.fromNullishOr(issues[0]).pipe(
                Option.map((issue): ReportProblemResult => ({
                  number: issue.number,
                  url: issue.url,
                })),
              ),
            ),
        }),
      ),
    );

  const post = (input: ReportProblemInput) =>
    gh(
      [
        "--method",
        "POST",
        `repos/${THREADLINES_REPOSITORY}/issues`,
        "--input",
        "-",
        "--jq",
        "{number, url: .html_url}",
      ],
      {
        timeoutMs: POST_TIMEOUT_MS,
        stdin: JSON.stringify({
          title: reportIssueTitle(input.title),
          body: buildReportIssueBody({
            draft: input,
            version: input.version,
            setup: input.setup,
            submissionId: input.submissionId,
          }),
        }),
      },
    );

  const settle = (submissionId: string, result: ReportProblemResult) => {
    posted.set(submissionId, result);
    unsettled.delete(submissionId);
    return result;
  };

  const submit: ProblemReportsShape["submit"] = (input) =>
    Effect.gen(function* () {
      const already = posted.get(input.submissionId);
      if (already) return already;

      // Before posting, a failure says whether an earlier try may have reached GitHub.
      const stopped = (reason: string) =>
        new ReportProblemError({ reason, uncertain: unsettled.has(input.submissionId) });

      const login = yield* currentLogin.pipe(
        Effect.mapError((error) => {
          const kind = failureKind(error);
          return stopped(
            kind === "noGitHubCli" || kind === "signedOut" || kind === "rateLimited"
              ? REASONS[kind]
              : REASONS.unreachable,
          );
        }),
      );
      if (login.toLowerCase() !== input.login.toLowerCase()) {
        return yield* stopped(
          `GitHub is now signed in as @${login}, not @${input.login}. Check the account, then post again.`,
        );
      }

      // Look before every post: an earlier try may have reached GitHub without an
      // answer, even one from before a restart. Never post without having looked.
      const earlier = yield* findPosted(login, input.submissionId).pipe(
        Effect.mapError(() =>
          stopped(unsettled.has(input.submissionId) ? REASONS.uncertain : REASONS.unreachable),
        ),
      );
      if (Option.isSome(earlier)) return settle(input.submissionId, earlier.value);

      unsettled.add(input.submissionId);
      const outcome = yield* post(input).pipe(Effect.result);
      if (outcome._tag === "Success") {
        const issue = decodePostedIssue(outcome.success.stdout);
        if (Option.isSome(issue)) return settle(input.submissionId, issue.value);
      } else {
        const kind = failureKind(outcome.failure);
        if (kind !== "unknown") {
          // GitHub answered, and said no: nothing was posted.
          unsettled.delete(input.submissionId);
          if (kind === "rejected") {
            return yield* refuse(REASONS.rejected);
          }
          return yield* refuse(REASONS[kind]);
        }
      }

      // No clear answer: GitHub may have the issue. Look once before saying so.
      const found = yield* findPosted(login, input.submissionId).pipe(
        Effect.orElseSucceed(() => Option.none<ReportProblemResult>()),
      );
      if (Option.isSome(found)) return settle(input.submissionId, found.value);
      return yield* new ReportProblemError({ reason: REASONS.uncertain, uncertain: true });
    }).pipe(lock.withPermits(1));

  return ProblemReports.of({ account, submit });
});

export const layer = Layer.effect(ProblemReports, make());
