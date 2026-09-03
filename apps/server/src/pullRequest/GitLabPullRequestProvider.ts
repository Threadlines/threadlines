import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";

import type {
  PullRequestAction,
  PullRequestActivity,
  PullRequestCapabilities,
  PullRequestComment,
  PullRequestListState,
  PullRequestMergeMethod,
  PullRequestReviewer,
  PullRequestReviewThread,
} from "@threadlines/contracts";
import { formatSchemaError } from "@threadlines/shared/schemaJson";

import type * as GitLabCliModule from "../sourceControl/GitLabCli.ts";
import { GitLabCli } from "../sourceControl/GitLabCli.ts";
import {
  buildGitLabDiscussionJson,
  buildGitLabGraphQlRequestJson,
  buildGitLabMergeRequestUpdateJson,
  buildGitLabNoteBodyJson,
  buildGitLabResolutionJson,
  buildGitLabReviewerIdsJson,
  decodeGitLabApprovalsJson,
  decodeGitLabAwardsJson,
  decodeGitLabCommitsJson,
  decodeGitLabDiffsJson,
  decodeGitLabDiscussionsJson,
  decodeGitLabMergeRequestDetailJson,
  decodeGitLabMergeRequestListJson,
  decodeGitLabNotesJson,
  decodeGitLabOwnAwardIdJson,
  decodeGitLabProjectJson,
  decodeGitLabProjectUsersJson,
  decodeGitLabViewerJson,
  GITLAB_AWARD_EMOJI_GRAPHQL_QUERY,
  gitLabAwardName,
  type GitLabDiffRefs,
} from "./gitLabMergeRequest.ts";
import { capPullRequestDiff, PULL_REQUEST_DIFF_MAX_BYTES } from "./pullRequestDiff.ts";
import {
  PullRequestProviderError,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";

const PROVIDER_KIND = "gitlab" as const;
const DIFF_TIMEOUT_MS = 60_000;
/** GitLab's own ceiling on `per_page`. */
const MAX_PAGE_SIZE = 100;
/** A merge waits on GitLab settling its pipeline and its merge train. */
const MERGE_TIMEOUT_MS = 60_000;

/**
 * Everything GitLab lets a reader do here. The project narrows `mergeMethods`,
 * because GitLab settles on one strategy per project rather than per merge
 * request.
 */
export const GITLAB_PULL_REQUEST_CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [
    "merge",
    "close",
    "reopen",
    "ready",
    "draft",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
  ],
  mergeMethods: ["merge", "squash", "rebase"],
  // Rebase alone: GitLab moves a stale branch onto its target by replaying it,
  // and has nothing that merges the target back in the way GitHub's update
  // button can. Declaring only what it does is what lets a request to merge the
  // target in be refused rather than quietly rebasing.
  updateMethods: ["rebase"],
  reactions: true,
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    // GitLab records an approval and nothing that says a merge request was
    // reviewed and rejected, so a refusal goes as a note naming the verdict.
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { pullRequest: true, comment: true },
};

/** The heading a refusal carries, GitLab having no verdict of its own for it. */
const REQUEST_CHANGES_HEADING = "**Requested changes**";

/** Turns a `glab` failure into the reason the page renders an action for. */
export function classifyGitLabFailure(detail: string): PullRequestProviderError["reason"] {
  const lower = detail.toLowerCase();
  if (
    lower.includes("not available on path") ||
    lower.includes("command not found") ||
    lower.includes("enoent")
  ) {
    return "missing-tool";
  }
  if (
    lower.includes("not authenticated") ||
    lower.includes("not logged in") ||
    lower.includes("authentication") ||
    lower.includes("auth login") ||
    lower.includes("401")
  ) {
    return "unauthenticated";
  }
  if (lower.includes("rate limit") || lower.includes("429")) {
    return "rate-limited";
  }
  return "failed";
}

/**
 * The line of a `glab` failure worth showing. The CLI stacks its own wrapper
 * around GitLab's complaint, and only the last line of that stack is the host
 * talking.
 */
function lastFailureLine(detail: string): string {
  const lines = detail
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 1 ? (lines[lines.length - 1] ?? detail.trim()) : detail.trim();
}

function toProviderError(operation: string, error: GitLabCliModule.GitLabCliError) {
  return new PullRequestProviderError({
    provider: PROVIDER_KIND,
    operation,
    reason: classifyGitLabFailure(error.detail),
    detail: lastFailureLine(error.detail),
  });
}

function decodeError(operation: string, subject: string, failure: Cause.Cause<Schema.SchemaError>) {
  return new PullRequestProviderError({
    provider: PROVIDER_KIND,
    operation,
    reason: "failed",
    detail: `GitLab CLI returned invalid ${subject} JSON: ${formatSchemaError(failure)}`,
  });
}

/** A GitLab project is addressed by its whole path, encoded as one segment. */
function projectPath(repository: string): string {
  return encodeURIComponent(repository.trim());
}

function query(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

/** GitLab's own name for each slice; `closed` already excludes merged ones. */
function stateParam(state: PullRequestListState): string {
  return state === "open" ? "opened" : state;
}

function actionArgs(
  action: PullRequestAction,
  mergeMethod: PullRequestMergeMethod | undefined,
): ReadonlyArray<string> {
  const strategy =
    mergeMethod === "squash" ? ["--squash"] : mergeMethod === "rebase" ? ["--rebase"] : [];
  switch (action) {
    // glab arms auto-merge whenever a pipeline is running. The button means merge now.
    case "merge":
      return ["merge", "--auto-merge=false", "--yes", ...strategy];
    // The same command with the flag the other way up: here the wait is the point.
    case "enable-auto-merge":
      return ["merge", "--auto-merge=true", "--yes", ...strategy];
    case "ready":
      return ["update", "--ready"];
    case "draft":
      return ["update", "--draft"];
    case "close":
      return ["close"];
    case "reopen":
      return ["reopen"];
    // A rebase, because GitLab has no merge-the-target-in equivalent of
    // GitHub's update button, which is why this host declares `rebase` alone.
    case "update-branch":
      return ["rebase"];
    // Never reached: taking the arming back has no `glab mr` command, so the
    // provider sends it to the API instead.
    case "disable-auto-merge":
      return [];
  }
}

export const make = Effect.fn("makeGitLabPullRequestProvider")(function* () {
  const gitlab = yield* GitLabCli;

  const run = (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  }) =>
    gitlab
      .execute({
        cwd: input.cwd,
        args: input.args,
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
      })
      .pipe(Effect.mapError((error) => toProviderError(input.operation, error)));

  /**
   * One REST call through `glab api`. A body travels on stdin, so a reader's
   * own words never reach argv; unlike `gh`, `glab api --input` sends no content
   * type at all and GitLab answers a bodyless one with HTTP 415.
   */
  const api = (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly path: string;
    readonly method?: "POST" | "PUT" | "DELETE";
    readonly stdin?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  }) =>
    run({
      operation: input.operation,
      cwd: input.cwd,
      args: [
        "api",
        input.path,
        ...(input.method === undefined ? [] : ["--method", input.method]),
        ...(input.stdin === undefined
          ? []
          : ["--input", "-", "--header", "Content-Type: application/json"]),
      ],
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
    });

  const apiRead = <A>(input: {
    readonly operation: string;
    readonly subject: string;
    readonly cwd: string;
    readonly path: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly decode: (raw: string) => Result.Result<A, Cause.Cause<Schema.SchemaError>>;
  }) =>
    api(input).pipe(
      Effect.flatMap((output) => {
        const decoded = input.decode(output.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(decodeError(input.operation, input.subject, decoded.failure));
      }),
    );

  const mergeRequestPath = (input: ProviderRepositoryRef & { readonly number: number }) =>
    `projects/${projectPath(input.repository)}/merge_requests/${input.number}`;

  const readViewer = (operation: string, cwd: string) =>
    apiRead({
      operation,
      subject: "user",
      cwd,
      path: "user",
      decode: decodeGitLabViewerJson,
    });

  /** The merge request itself, which several calls need different parts of. */
  const readDetail = (
    operation: string,
    input: ProviderRepositoryRef & { readonly number: number },
  ) =>
    apiRead({
      operation,
      subject: "merge request",
      cwd: input.cwd,
      // How far behind the target branch this one is comes only when asked for
      // by name, and it is asked for here because it is the same merge request.
      path: `${mergeRequestPath(input)}?${query([["include_diverged_commits_count", "true"]])}`,
      decode: decodeGitLabMergeRequestDetailJson,
    });

  const requireDiffRefs = (
    operation: string,
    input: ProviderRepositoryRef & { readonly number: number },
  ) =>
    readDetail(operation, input).pipe(
      Effect.flatMap((row): Effect.Effect<GitLabDiffRefs, PullRequestProviderError> =>
        row.diffRefs === null
          ? Effect.fail(
              new PullRequestProviderError({
                provider: PROVIDER_KIND,
                operation,
                reason: "failed",
                detail: "This merge request reported no revisions to place a comment against.",
              }),
            )
          : Effect.succeed(row.diffRefs),
      ),
    );

  /** Where an award is written: a note of the merge request, or the request. */
  const awardPath = (
    input: ProviderRepositoryRef & { readonly number: number; readonly subjectId?: string },
  ) => {
    const base = mergeRequestPath(input);
    return input.subjectId === undefined
      ? `${base}/award_emoji`
      : `${base}/notes/${encodeURIComponent(input.subjectId)}/award_emoji`;
  };

  const provider: PullRequestProviderApi = {
    kind: PROVIDER_KIND,
    capabilities: GITLAB_PULL_REQUEST_CAPABILITIES,

    getViewer: (input) => readViewer("getViewer", input.cwd),

    listChangeRequests: (input) =>
      apiRead({
        operation: "list",
        subject: "MR list",
        cwd: input.cwd,
        path: `projects/${projectPath(input.repository)}/merge_requests?${query([
          ["state", stateParam(input.state)],
          ["order_by", "updated_at"],
          ["sort", "desc"],
          ["per_page", String(Math.min(input.limit, MAX_PAGE_SIZE))],
        ])}`,
        decode: decodeGitLabMergeRequestListJson,
      }).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            ...row,
            // GitLab reports neither added nor removed lines on a merge
            // request, so the row omits the stat rather than inventing one.
            additions: 0,
            deletions: 0,
          })),
        ),
      ),

    getChangeRequest: (input) =>
      Effect.all(
        [
          readDetail("detail", input),
          // Approval is the only per-reviewer verdict GitLab records, and it
          // lives on an endpoint of its own. A refusal to answer costs the
          // reviewers their verdicts, not the reader their detail.
          apiRead({
            operation: "detail",
            subject: "approvals",
            cwd: input.cwd,
            path: `${mergeRequestPath(input)}/approvals`,
            decode: decodeGitLabApprovalsJson,
          }).pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([]))),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.map(([row, approvals]) => {
          const approved = new Set(approvals.map((login) => login.toLowerCase()));
          const reviewers = row.reviewers.map((reviewer): PullRequestReviewer => ({
            id: reviewer.id,
            kind: "user",
            login: reviewer.login,
            state: approved.has(reviewer.login.toLowerCase()) ? "approved" : "pending",
          }));
          // Somebody may approve without having been asked, which GitLab
          // reports on the approvals endpoint alone.
          const listed = new Set(reviewers.map((reviewer) => reviewer.login.toLowerCase()));
          for (const login of approvals) {
            if (!listed.has(login.toLowerCase())) {
              reviewers.push({ id: login, kind: "user", login, state: "approved" });
            }
          }
          return {
            ...row,
            additions: 0,
            deletions: 0,
            reviewers,
            // A GitLab too old to count the divergence says nothing rather than
            // "up to date": a missing banner beats a wrong all-clear.
            baseComparison:
              row.behindBy === null ? "unknown" : row.behindBy > 0 ? "behind" : "up-to-date",
            ...(approvals.length > 0 ? { reviewDecision: "approved" as const } : {}),
          };
        }),
      ),

    getChangeRequestActivity: (input) =>
      Effect.gen(function* () {
        // GitLab names who wrote a note but never whether that is the reader,
        // so the account is read once and the comparison made here.
        const viewer = yield* readViewer("activity", input.cwd).pipe(
          Effect.catch(() => Effect.succeed<string | null>(null)),
        );
        const page = query([["per_page", String(MAX_PAGE_SIZE)]]);
        const [comments, threads, commits, awards] = yield* Effect.all(
          [
            apiRead({
              operation: "activity",
              subject: "notes",
              cwd: input.cwd,
              path: `${mergeRequestPath(input)}/notes?${page}&${query([
                ["order_by", "created_at"],
                ["sort", "asc"],
              ])}`,
              decode: (raw) => decodeGitLabNotesJson(raw, viewer),
            }),
            apiRead({
              operation: "activity",
              subject: "discussions",
              cwd: input.cwd,
              path: `${mergeRequestPath(input)}/discussions?${page}`,
              decode: (raw) => decodeGitLabDiscussionsJson(raw, viewer),
            }),
            apiRead({
              operation: "activity",
              subject: "commits",
              cwd: input.cwd,
              path: `${mergeRequestPath(input)}/commits?${page}`,
              decode: decodeGitLabCommitsJson,
            }),
            // The notes endpoint carries no award of any kind, so they are read
            // beside it. A failed read costs the conversation its reactions
            // rather than its words.
            api({
              operation: "activity",
              cwd: input.cwd,
              path: "graphql",
              method: "POST",
              stdin: buildGitLabGraphQlRequestJson({
                query: GITLAB_AWARD_EMOJI_GRAPHQL_QUERY,
                variables: { fullPath: input.repository, iid: String(input.number) },
              }),
            }).pipe(
              Effect.flatMap((output) => {
                const decoded = decodeGitLabAwardsJson(output.stdout.trim(), viewer);
                return Result.isSuccess(decoded)
                  ? Effect.succeed(decoded.success)
                  : Effect.fail(decodeError("activity", "awards", decoded.failure));
              }),
              Effect.catch(() =>
                Effect.succeed({
                  reactions: [],
                  reactionsByNoteId: new Map<string, ReadonlyArray<never>>(),
                }),
              ),
            ),
          ],
          { concurrency: 4 },
        );

        return {
          comments: comments.map((comment): PullRequestComment => ({
            ...comment,
            reactions: awards.reactionsByNoteId.get(comment.id) ?? [],
          })),
          commits,
          reviewThreads: threads.map((thread): PullRequestReviewThread => ({
            ...thread,
            comments: thread.comments.map((comment) => ({
              ...comment,
              reactions: awards.reactionsByNoteId.get(comment.id) ?? [],
            })),
          })),
          reactions: awards.reactions,
        } satisfies PullRequestActivity;
      }),

    getDiff: (input) =>
      api({
        operation: "diff",
        cwd: input.cwd,
        path: `${mergeRequestPath(input)}/diffs?${query([
          ["per_page", String(MAX_PAGE_SIZE)],
          ["page", "1"],
        ])}`,
        timeoutMs: DIFF_TIMEOUT_MS,
        maxOutputBytes: PULL_REQUEST_DIFF_MAX_BYTES,
      }).pipe(
        Effect.flatMap((output) => {
          // GitLab hands its diff over as JSON, so a byte-truncated answer is a
          // broken document rather than a short patch: there is nothing to
          // salvage, and saying so beats a decode failure nobody can read.
          if (output.stdoutTruncated) {
            return Effect.fail(
              new PullRequestProviderError({
                provider: PROVIDER_KIND,
                operation: "diff",
                reason: "failed",
                detail: "This merge request's diff was too large to read.",
              }),
            );
          }
          const decoded = decodeGitLabDiffsJson(output.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(
                capPullRequestDiff({
                  patch: decoded.success.patch,
                  // A full page means GitLab has more files than this read asked
                  // for, so the patch stops short of the whole change set.
                  truncated: decoded.success.truncated || decoded.success.rawCount >= MAX_PAGE_SIZE,
                }),
              )
            : Effect.fail(decodeError("diff", "diff", decoded.failure));
        }),
      ),

    runAction: (input) => {
      // `glab mr merge` arms auto-merge and never disarms it, so the one
      // direction the CLI has no flag for goes to the API instead.
      if (input.action === "disable-auto-merge") {
        return api({
          operation: "runAction",
          cwd: input.cwd,
          path: `${mergeRequestPath(input)}/cancel_merge_when_pipeline_succeeds`,
          method: "POST",
        }).pipe(Effect.asVoid);
      }
      const [subcommand = input.action, ...flags] = actionArgs(input.action, input.mergeMethod);
      return run({
        operation: "runAction",
        cwd: input.cwd,
        args: ["mr", subcommand, String(input.number), "--repo", input.repository, ...flags],
        ...(input.action === "merge" ? { timeoutMs: MERGE_TIMEOUT_MS } : {}),
      }).pipe(Effect.asVoid);
    },

    comment: (input) =>
      api({
        operation: "comment",
        cwd: input.cwd,
        path: `${mergeRequestPath(input)}/notes`,
        method: "POST",
        stdin: buildGitLabNoteBodyJson(input.body),
      }).pipe(
        // GitLab answers with the note, whose own URL it does not carry; the
        // merge request page is where the reader finds it.
        Effect.as({ url: null }),
      ),

    submitReview: (input) =>
      Effect.gen(function* () {
        // GitLab has no pending review to attach comments to, so a review is
        // replayed as the requests it is made of: the line comments, then the
        // summary, then the verdict. A failure part-way leaves what already
        // landed in place, which is why the verdict goes last: a half-sent
        // review is never an approval.
        if (input.comments.length > 0) {
          const refs = yield* requireDiffRefs("submitReview", input);
          yield* Effect.forEach(
            input.comments,
            (comment) =>
              api({
                operation: "submitReview",
                cwd: input.cwd,
                path: `${mergeRequestPath(input)}/discussions`,
                method: "POST",
                stdin: buildGitLabDiscussionJson({ comment, refs }),
              }),
            { discard: true },
          );
        }

        const body = input.body.trim();
        if (body.length > 0 || input.verdict === "request-changes") {
          yield* api({
            operation: "submitReview",
            cwd: input.cwd,
            path: `${mergeRequestPath(input)}/notes`,
            method: "POST",
            // GitLab records no "changes requested", so the refusal is a note
            // that says so in its first line.
            stdin: buildGitLabNoteBodyJson(
              input.verdict === "request-changes"
                ? `${REQUEST_CHANGES_HEADING}\n\n${body}`
                : input.body,
            ),
          });
        }

        if (input.verdict === "approve") {
          yield* api({
            operation: "submitReview",
            cwd: input.cwd,
            path: `${mergeRequestPath(input)}/approve`,
            method: "POST",
          });
        }

        return { url: null };
      }),

    replyToThread: (input) =>
      api({
        operation: "replyToThread",
        cwd: input.cwd,
        path: `${mergeRequestPath(input)}/discussions/${encodeURIComponent(input.threadId)}/notes`,
        method: "POST",
        stdin: buildGitLabNoteBodyJson(input.body),
      }).pipe(Effect.asVoid),

    setThreadResolution: (input) =>
      api({
        operation: "setThreadResolution",
        cwd: input.cwd,
        path: `${mergeRequestPath(input)}/discussions/${encodeURIComponent(input.threadId)}`,
        method: "PUT",
        stdin: buildGitLabResolutionJson(input.resolved),
      }).pipe(Effect.asVoid),

    // Every subject reachable here is addressed under this merge request's own
    // path, so an id from elsewhere cannot be written to: GitLab answers 404
    // for a note that does not hang off it.
    setReaction: (input) =>
      Effect.gen(function* () {
        const subject = awardPath(input);
        if (input.reacted) {
          yield* api({
            operation: "setReaction",
            cwd: input.cwd,
            path: `${subject}?${query([["name", gitLabAwardName(input.content)]])}`,
            method: "POST",
          });
          return;
        }
        // GitLab deletes an award by its id and takes no emoji name there, so
        // the reader's own award is looked up first. Nothing to delete is
        // success: the reaction the caller asked to take back is already gone.
        const viewer = yield* readViewer("setReaction", input.cwd);
        if (viewer === null) {
          return yield* Effect.fail(
            new PullRequestProviderError({
              provider: PROVIDER_KIND,
              operation: "setReaction",
              reason: "unauthenticated",
              detail: "GitLab did not name the signed-in account.",
            }),
          );
        }
        const listed = yield* api({
          operation: "setReaction",
          cwd: input.cwd,
          path: subject,
        });
        const own = decodeGitLabOwnAwardIdJson(listed.stdout.trim(), {
          content: input.content,
          viewer,
        });
        if (!Result.isSuccess(own)) {
          return yield* Effect.fail(decodeError("setReaction", "awards", own.failure));
        }
        if (own.success === null) {
          return;
        }
        yield* api({
          operation: "setReaction",
          cwd: input.cwd,
          path: `${subject}/${own.success}`,
          method: "DELETE",
        });
      }),

    updateChangeRequest: (input) =>
      api({
        operation: "update",
        cwd: input.cwd,
        path: mergeRequestPath(input),
        method: "PUT",
        stdin: buildGitLabMergeRequestUpdateJson({
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
        }),
      }).pipe(Effect.asVoid),

    // The kind is not read: every remark this provider hands out, positioned or
    // not, carries a plain REST note id, and one endpoint rewrites both.
    updateComment: (input) =>
      api({
        operation: "updateComment",
        cwd: input.cwd,
        path: `${mergeRequestPath(input)}/notes/${encodeURIComponent(input.commentId)}`,
        method: "PUT",
        stdin: buildGitLabNoteBodyJson(input.body),
      }).pipe(Effect.asVoid),

    // Users only: GitLab asks a person for a review, and the groups that stand
    // in for one live in approval rules rather than on a merge request.
    listReviewerCandidates: (input) =>
      Effect.all(
        [
          apiRead({
            operation: "reviewerCandidates",
            subject: "project users",
            cwd: input.cwd,
            path: `projects/${projectPath(input.repository)}/users?${query([
              ["per_page", String(MAX_PAGE_SIZE)],
            ])}`,
            decode: decodeGitLabProjectUsersJson,
          }),
          readDetail("reviewerCandidates", input),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.map(([users, row]) => {
          const requested = new Set(row.reviewers.map((reviewer) => reviewer.login.toLowerCase()));
          const author = row.author?.login.toLowerCase() ?? null;
          return {
            // The author is dropped rather than shown unusable: GitLab refuses
            // to make whoever opened a merge request its reviewer.
            candidates: users.candidates.flatMap((candidate) =>
              candidate.login.toLowerCase() === author
                ? []
                : [{ ...candidate, requested: requested.has(candidate.login.toLowerCase()) }],
            ),
          };
        }),
      ),

    setReviewerRequest: (input) =>
      readDetail("requestReviewers", input).pipe(
        Effect.flatMap((row) =>
          api({
            operation: "requestReviewers",
            cwd: input.cwd,
            path: mergeRequestPath(input),
            method: "PUT",
            stdin: buildGitLabReviewerIdsJson({
              current: row.reviewers.map((reviewer) => reviewer.id),
              reviewers: input.reviewers,
              requested: input.requested,
            }),
          }),
        ),
        Effect.asVoid,
      ),

    getRepositoryAccess: (input) =>
      apiRead({
        operation: "repository",
        subject: "project",
        cwd: input.cwd,
        path: `projects/${projectPath(input.repository)}?license=false`,
        decode: decodeGitLabProjectJson,
      }),
  };

  return provider;
});
