import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";

import type {
  PullRequestActivity,
  PullRequestCapabilities,
  PullRequestListState,
  PullRequestReviewer,
} from "@threadlines/contracts";
import { formatSchemaError } from "@threadlines/shared/schemaJson";

import type * as BitbucketApiModule from "../sourceControl/BitbucketApi.ts";
import { BitbucketApi } from "../sourceControl/BitbucketApi.ts";
import {
  buildBitbucketCommentJson,
  buildBitbucketInlineCommentJson,
  buildBitbucketMergeJson,
  buildBitbucketPullRequestUpdateJson,
  buildBitbucketReplyJson,
  buildBitbucketReviewersJson,
  buildBitbucketReviewThreads,
  decodeBitbucketCommentsJson,
  decodeBitbucketCommitsJson,
  decodeBitbucketConflictsJson,
  decodeBitbucketDiffStatJson,
  decodeBitbucketPullRequestJson,
  decodeBitbucketPullRequestPageJson,
  decodeBitbucketRepositoryJson,
  decodeBitbucketRepositoryPermissionJson,
  decodeBitbucketStatusesJson,
  decodeBitbucketViewerJson,
  decodeBitbucketWorkspaceMembersJson,
  type BitbucketPullRequestRow,
} from "./bitbucketPullRequest.ts";
import { capPullRequestDiff } from "./pullRequestDiff.ts";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";

const PROVIDER_KIND = "bitbucket" as const;
/** Bitbucket's own ceiling on `pagelen`. */
const MAX_PAGE_SIZE = 50;
/** Bitbucket's permission endpoint was withdrawn and now answers this to everyone. */
const PERMISSION_ENDPOINT_REMOVED_STATUS = 410;

/**
 * Everything Bitbucket lets a reader do here. Bitbucket publishes no
 * per-repository list of allowed strategies, so all three are offered and one
 * the repository forbids fails at the merge.
 */
export const BITBUCKET_PULL_REQUEST_CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  // Bitbucket has no endpoint that reopens a declined pull request, and nothing
  // documented that moves one in or out of draft, so neither is offered rather
  // than failing when pressed.
  actions: ["merge", "close"],
  mergeMethods: ["merge", "squash", "rebase"],
  updateMethods: [],
  // Bitbucket Cloud's API exposes no reaction on a pull request or a comment.
  reactions: false,
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { pullRequest: true, comment: true },
};

/** The failures that mean the credentials are the problem, not one request. */
export function classifyBitbucketFailure(
  error: BitbucketApiModule.BitbucketApiError,
): PullRequestProviderError["reason"] {
  // Bitbucket is read over HTTP with credentials from the server's environment,
  // so there is no tool to be missing: unusable means absent or refused
  // credentials.
  if (error.status === 401 || error.status === 403) {
    return "unauthenticated";
  }
  if (error.status === 429) {
    return "rate-limited";
  }
  return "failed";
}

function toProviderError(operation: string, error: BitbucketApiModule.BitbucketApiError) {
  return new PullRequestProviderError({
    provider: PROVIDER_KIND,
    operation,
    reason: classifyBitbucketFailure(error),
    detail: error.detail,
  });
}

function decodeError(operation: string, subject: string, failure: Cause.Cause<Schema.SchemaError>) {
  return new PullRequestProviderError({
    provider: PROVIDER_KIND,
    operation,
    reason: "failed",
    detail: `Bitbucket returned invalid ${subject} JSON: ${formatSchemaError(failure)}`,
  });
}

/**
 * Bitbucket unions repeated `state` parameters, so a slice that spans several of
 * its states asks for each. It separates a declined pull request from one
 * superseded by another, and both read as closed here.
 */
function stateParams(state: PullRequestListState): ReadonlyArray<string> {
  switch (state) {
    case "open":
      return ["OPEN"];
    case "merged":
      return ["MERGED"];
    case "closed":
      return ["DECLINED", "SUPERSEDED"];
  }
}

function toChangeRequest(row: BitbucketPullRequestRow): ProviderChangeRequest {
  return {
    number: row.number,
    title: row.title,
    url: row.url,
    author: row.author,
    headBranch: row.headBranch,
    baseBranch: row.baseBranch,
    state: row.state,
    isDraft: row.isDraft,
    // Line counts are a read of their own, worth spending only on the detail.
    additions: 0,
    deletions: 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    reviewRequestedLogins: row.reviewRequestedLogins,
    // Bitbucket has no labels on a pull request.
    labels: [],
  };
}

export const make = Effect.fn("makeBitbucketPullRequestProvider")(function* () {
  const bitbucket = yield* BitbucketApi;

  const request = (input: {
    readonly operation: string;
    readonly method: "GET" | "POST" | "PUT" | "DELETE";
    readonly path: string;
    readonly body?: string;
  }) =>
    bitbucket
      .request({
        method: input.method,
        path: input.path,
        ...(input.body === undefined ? {} : { body: input.body }),
      })
      .pipe(Effect.mapError((error) => toProviderError(input.operation, error)));

  const read = <A>(input: {
    readonly operation: string;
    readonly subject: string;
    readonly path: string;
    readonly decode: (raw: string) => Result.Result<A, Cause.Cause<Schema.SchemaError>>;
  }) =>
    request({ operation: input.operation, method: "GET", path: input.path }).pipe(
      Effect.flatMap((response) => {
        const decoded = input.decode(response.body);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(decodeError(input.operation, input.subject, decoded.failure));
      }),
    );

  /** `workspace/slug`; Bitbucket has no deeper nesting to address. */
  const repositoryPath = (operation: string, repository: string) => {
    const segments = repository
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    const [workspace, slug] = segments;
    return segments.length === 2 && workspace !== undefined && slug !== undefined
      ? Effect.succeed({
          path: `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`,
          workspace,
        })
      : Effect.fail(
          new PullRequestProviderError({
            provider: PROVIDER_KIND,
            operation,
            reason: "failed",
            detail: "Bitbucket repositories are addressed as workspace/repository.",
          }),
        );
  };

  const withRepository = <A>(
    operation: string,
    repository: string,
    use: (input: {
      readonly path: string;
      readonly workspace: string;
    }) => Effect.Effect<A, PullRequestProviderError>,
  ) => repositoryPath(operation, repository).pipe(Effect.flatMap(use));

  const pullRequestPath = (path: string, number: number) => `${path}/pullrequests/${number}`;

  const readViewer = (operation: string) =>
    read({ operation, subject: "user", path: "/user", decode: decodeBitbucketViewerJson });

  const readPullRequest = (
    operation: string,
    input: ProviderRepositoryRef & { readonly number: number },
  ) =>
    withRepository(operation, input.repository, ({ path }) =>
      read({
        operation,
        subject: "pull request",
        path: pullRequestPath(path, input.number),
        decode: decodeBitbucketPullRequestJson,
      }),
    );

  /**
   * Whether the credentials may write. Bitbucket withdrew this endpoint
   * (CHANGE-2770) and now answers HTTP 410 to every account, whatever it may
   * do — that is a deprecated endpoint rather than a permission being refused,
   * so it reads as a standing that could not be learned, which grants and
   * leaves the merge itself to say why if the account may not do it.
   */
  const readCanWrite = (operation: string, repository: string) =>
    read({
      operation,
      subject: "permissions",
      path: `/user/permissions/repositories?q=${encodeURIComponent(
        `repository.full_name="${repository.trim().replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
      )}`,
      decode: decodeBitbucketRepositoryPermissionJson,
    }).pipe(
      Effect.catchIf(
        (error) => error.detail.includes(`HTTP ${PERMISSION_ENDPOINT_REMOVED_STATUS}`),
        () => Effect.succeed(true),
      ),
    );

  const provider: PullRequestProviderApi = {
    kind: PROVIDER_KIND,
    capabilities: BITBUCKET_PULL_REQUEST_CAPABILITIES,

    // Bitbucket credentials come from the server's environment rather than a
    // checkout, so the account is the same whichever workspace asks.
    getViewer: () => readViewer("getViewer"),

    listChangeRequests: (input) =>
      withRepository("list", input.repository, ({ path }) =>
        read({
          operation: "list",
          subject: "PR list",
          // Reviewers are left off a listing by default, and the viewer's own
          // review request is worked out from them.
          path: `${path}/pullrequests?${stateParams(input.state)
            .map((state) => `state=${state}`)
            .join(
              "&",
            )}&pagelen=${Math.min(input.limit, MAX_PAGE_SIZE)}&sort=-updated_on&fields=%2Bvalues.reviewers`,
          decode: decodeBitbucketPullRequestPageJson,
        }).pipe(Effect.map((page) => page.items.map(toChangeRequest))),
      ),

    getChangeRequest: (input) =>
      withRepository("detail", input.repository, ({ path }) => {
        const target = pullRequestPath(path, input.number);
        return Effect.all(
          [
            read({
              operation: "detail",
              subject: "pull request",
              path: target,
              decode: decodeBitbucketPullRequestJson,
            }),
            read({
              operation: "detail",
              subject: "diffstat",
              path: `${target}/diffstat?pagelen=${MAX_PAGE_SIZE}`,
              decode: decodeBitbucketDiffStatJson,
            }),
            // Bitbucket reports no conflict state on a pull request itself, and
            // an unreadable conflicts endpoint leaves it unknown rather than
            // failing a detail the reader can still use.
            read({
              operation: "detail",
              subject: "conflicts",
              path: `${target}/conflicts`,
              decode: decodeBitbucketConflictsJson,
            }).pipe(Effect.catch(() => Effect.succeed("unknown" as const))),
            read({
              operation: "detail",
              subject: "statuses",
              path: `${target}/statuses?pagelen=${MAX_PAGE_SIZE}`,
              decode: decodeBitbucketStatusesJson,
            }).pipe(Effect.catch(() => Effect.succeed({ items: [], next: null }))),
          ],
          { concurrency: 4 },
        ).pipe(
          Effect.map(([row, diffStat, mergeability, checks]) => ({
            ...toChangeRequest(row),
            additions: diffStat.additions,
            deletions: diffStat.deletions,
            changedFiles: diffStat.changedFiles,
            body: row.body,
            mergeability,
            // Bitbucket stamps no separate merged or closed time; the pull
            // request's last update is when it settled.
            mergedAt: row.state === "merged" ? row.updatedAt : null,
            closedAt: row.state === "closed" ? row.updatedAt : null,
            reviewers: row.reviewers.map((reviewer): PullRequestReviewer => ({
              id: reviewer.id,
              kind: "user",
              login: reviewer.login,
              state:
                row.reviews.find(
                  (review) => review.author?.login.toLowerCase() === reviewer.login.toLowerCase(),
                )?.reviewState ?? "pending",
              avatarUrl: reviewer.avatarUrl,
            })),
            checks: checks.items,
            // Bitbucket compares no branch with its base.
            baseComparison: "unknown" as const,
            behindBy: null,
            // Bitbucket has nothing that arms a merge to run on its own.
            autoMergeEnabled: null,
          })),
        );
      }),

    getChangeRequestActivity: (input) =>
      Effect.gen(function* () {
        // Bitbucket names who wrote a remark but never whether that is the
        // reader, so the account is read once and the comparison made here.
        const viewer = yield* readViewer("activity").pipe(
          Effect.catch(() => Effect.succeed<string | null>(null)),
        );
        return yield* withRepository("activity", input.repository, ({ path }) => {
          const target = pullRequestPath(path, input.number);
          return Effect.all(
            [
              // The verdicts ride on the pull request itself.
              read({
                operation: "activity",
                subject: "pull request",
                path: target,
                decode: decodeBitbucketPullRequestJson,
              }),
              read({
                operation: "activity",
                subject: "comments",
                path: `${target}/comments?pagelen=${MAX_PAGE_SIZE}`,
                decode: (raw) => decodeBitbucketCommentsJson(raw, viewer),
              }),
              read({
                operation: "activity",
                subject: "commits",
                path: `${target}/commits?pagelen=${MAX_PAGE_SIZE}`,
                decode: decodeBitbucketCommitsJson,
              }),
            ],
            { concurrency: 3 },
          ).pipe(
            Effect.map(([row, comments, commits]): PullRequestActivity => ({
              comments: [...comments.comments, ...row.reviews].toSorted((left, right) =>
                left.createdAt.localeCompare(right.createdAt),
              ),
              commits: commits.items,
              reviewThreads: buildBitbucketReviewThreads(comments.entries, viewer),
              reactions: [],
            })),
          );
        });
      }),

    // `/diff` answers with the whole patch and pages nothing.
    getDiff: (input) =>
      withRepository("diff", input.repository, ({ path }) =>
        request({
          operation: "diff",
          method: "GET",
          path: `${pullRequestPath(path, input.number)}/diff`,
        }).pipe(
          Effect.map((response) => capPullRequestDiff({ patch: response.body, truncated: false })),
        ),
      ),

    runAction: (input) =>
      withRepository("runAction", input.repository, ({ path }) => {
        const target = pullRequestPath(path, input.number);
        // Only merge and close reach here: the provider declares nothing else,
        // and the service refuses an action the capabilities do not carry.
        return input.action === "merge"
          ? request({
              operation: "runAction",
              method: "POST",
              path: `${target}/merge`,
              body: buildBitbucketMergeJson(input.mergeMethod),
            }).pipe(Effect.asVoid)
          : request({
              operation: "runAction",
              method: "POST",
              path: `${target}/decline`,
            }).pipe(Effect.asVoid);
      }),

    comment: (input) =>
      withRepository("comment", input.repository, ({ path }) =>
        request({
          operation: "comment",
          method: "POST",
          path: `${pullRequestPath(path, input.number)}/comments`,
          body: buildBitbucketCommentJson(input.body),
        }).pipe(Effect.as({ url: null })),
      ),

    submitReview: (input) =>
      withRepository("submitReview", input.repository, ({ path }) =>
        Effect.gen(function* () {
          const target = pullRequestPath(path, input.number);
          // Bitbucket has no pending review, so a review is replayed as the
          // requests it is made of: the line comments, then the summary, then
          // the verdict. The verdict goes last so a review that fails part-way
          // is never left standing as an approval.
          yield* Effect.forEach(
            input.comments,
            (comment) =>
              request({
                operation: "submitReview",
                method: "POST",
                path: `${target}/comments`,
                body: buildBitbucketInlineCommentJson(comment),
              }),
            { discard: true },
          );
          if (input.body.trim().length > 0) {
            yield* request({
              operation: "submitReview",
              method: "POST",
              path: `${target}/comments`,
              body: buildBitbucketCommentJson(input.body),
            });
          }
          if (input.verdict === "approve") {
            yield* request({
              operation: "submitReview",
              method: "POST",
              path: `${target}/approve`,
            });
          }
          if (input.verdict === "request-changes") {
            yield* request({
              operation: "submitReview",
              method: "POST",
              path: `${target}/request-changes`,
            });
          }
          return { url: null };
        }),
      ),

    replyToThread: (input) =>
      withRepository("replyToThread", input.repository, ({ path }) =>
        request({
          operation: "replyToThread",
          method: "POST",
          path: `${pullRequestPath(path, input.number)}/comments`,
          body: buildBitbucketReplyJson({ parentId: input.threadId, body: input.body }),
        }).pipe(Effect.asVoid),
      ),

    setThreadResolution: (input) =>
      withRepository("setThreadResolution", input.repository, ({ path }) =>
        request({
          operation: "setThreadResolution",
          // Resolving is a sub-resource that is created and deleted, not a field.
          method: input.resolved ? "POST" : "DELETE",
          path: `${pullRequestPath(path, input.number)}/comments/${encodeURIComponent(
            input.threadId,
          )}/resolve`,
        }).pipe(Effect.asVoid),
      ),

    // Never called: `capabilities.reactions` is false, and the service refuses
    // without it. It exists because every provider answers the whole port.
    setReaction: () =>
      Effect.fail(
        new PullRequestProviderError({
          provider: PROVIDER_KIND,
          operation: "setReaction",
          reason: "failed",
          detail: "Bitbucket does not support reactions.",
        }),
      ),

    updateChangeRequest: (input) =>
      withRepository("update", input.repository, ({ path }) =>
        request({
          operation: "update",
          method: "PUT",
          path: pullRequestPath(path, input.number),
          body: buildBitbucketPullRequestUpdateJson({
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
          }),
        }).pipe(Effect.asVoid),
      ),

    // The kind is not read: Bitbucket keeps a pull request's remarks and its
    // line comments in one collection, and this endpoint rewrites either.
    updateComment: (input) =>
      withRepository("updateComment", input.repository, ({ path }) =>
        request({
          operation: "updateComment",
          method: "PUT",
          path: `${pullRequestPath(path, input.number)}/comments/${encodeURIComponent(
            input.commentId,
          )}`,
          body: buildBitbucketCommentJson(input.body),
        }).pipe(Effect.asVoid),
      ),

    // Users only: Bitbucket asks an account for a review, and has no group that
    // stands in for one on a pull request.
    listReviewerCandidates: (input) =>
      withRepository("reviewerCandidates", input.repository, ({ path, workspace }) =>
        Effect.all(
          [
            read({
              operation: "reviewerCandidates",
              subject: "pull request",
              path: pullRequestPath(path, input.number),
              decode: decodeBitbucketPullRequestJson,
            }),
            read({
              operation: "reviewerCandidates",
              subject: "workspace members",
              path: `/workspaces/${encodeURIComponent(workspace)}/members?pagelen=${MAX_PAGE_SIZE}`,
              decode: decodeBitbucketWorkspaceMembersJson,
            }),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(([row, members]) => {
            const requested = new Set(row.reviewers.map((reviewer) => reviewer.id));
            const author = row.author?.login.toLowerCase() ?? null;
            return {
              // The author is dropped rather than shown unusable: Bitbucket
              // refuses to make whoever opened a pull request its reviewer.
              candidates: members.items.flatMap((candidate) =>
                candidate.login.toLowerCase() === author
                  ? []
                  : [{ ...candidate, requested: requested.has(candidate.id) }],
              ),
            };
          }),
        ),
      ),

    setReviewerRequest: (input) =>
      withRepository("requestReviewers", input.repository, ({ path }) =>
        readPullRequest("requestReviewers", input).pipe(
          Effect.flatMap((row) =>
            request({
              operation: "requestReviewers",
              method: "PUT",
              path: pullRequestPath(path, input.number),
              body: buildBitbucketReviewersJson({
                current: row.reviewers.map((reviewer) => reviewer.id),
                reviewers: input.reviewers,
                requested: input.requested,
              }),
            }),
          ),
          Effect.asVoid,
        ),
      ),

    getRepositoryAccess: (input) =>
      withRepository("repository", input.repository, ({ path }) =>
        Effect.all(
          [
            readCanWrite("repository", input.repository),
            read({
              operation: "repository",
              subject: "repository",
              path,
              decode: decodeBitbucketRepositoryJson,
            }),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(([canWrite, defaultBranch]) => ({
            canWrite,
            mergeMethods: BITBUCKET_PULL_REQUEST_CAPABILITIES.mergeMethods,
            defaultBranch,
          })),
        ),
      ),
  };

  return provider;
});
