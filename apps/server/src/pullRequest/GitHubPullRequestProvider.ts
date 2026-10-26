import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";

import { withGitHubMergeQueue } from "../sourceControl/gitHubMergeQueue.ts";
import type {
  PullRequestAction,
  PullRequestActivity,
  PullRequestActor,
  PullRequestBaseComparison,
  PullRequestCapabilities,
  PullRequestComment,
  PullRequestListState,
  PullRequestMergeMethod,
  PullRequestReviewer,
  PullRequestUpdateMethod,
} from "@threadlines/contracts";
import { formatSchemaError } from "@threadlines/shared/schemaJson";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import {
  findAuthenticatedGitHubAccount,
  parseGitHubAuthStatus,
} from "../sourceControl/gitHubAuthStatus.ts";
import {
  AVATAR_NODES_GRAPHQL_QUERY,
  decodeGitHubAvatarNodesJson,
  derivedGitHubAvatarUrl,
  gitHubHostFromUrl,
} from "./gitHubAvatar.ts";
import {
  decodeGitHubPullRequestActivityJson,
  decodeGitHubPullRequestDetailJson,
  decodeGitHubRepositoryJson,
  GITHUB_PULL_REQUEST_ACTIVITY_FIELDS,
  GITHUB_PULL_REQUEST_DETAIL_FIELDS,
  type GitHubPullRequestDetailRow,
} from "./gitHubPullRequestDetail.ts";
import {
  ADD_REACTION_GRAPHQL_MUTATION,
  AUTHORED_PULL_REQUESTS_GRAPHQL_QUERY,
  AUTO_MERGE_READINESS_GRAPHQL_QUERY,
  buildGitHubReviewerRequestJson,
  buildGitHubReviewSubmissionJson,
  decodeGitHubAuthoredPullRequestsJson,
  decodeGitHubDetailBaseStateJson,
  decodeGitHubImmediatelyMergeableJson,
  decodeGitHubMergeQueueStandingJson,
  decodeGitHubPullRequestConversationJson,
  decodeGitHubPullRequestLookupJson,
  decodeGitHubPullRequestNodeIdJson,
  decodeGitHubReviewerCandidatesJson,
  decodeGitHubSubjectScopeJson,
  DEQUEUE_PULL_REQUEST_GRAPHQL_MUTATION,
  DETAIL_BASE_STATE_GRAPHQL_QUERY,
  encodeGraphQlRequestJson,
  gitHubAuthoredSearchQuery,
  gitHubPullRequestLookupRequest,
  gitHubReactionContent,
  type GitHubDetailBaseState,
  type GitHubGraphQlVariable,
  MERGE_QUEUE_STANDING_GRAPHQL_QUERY,
  PULL_REQUEST_CONVERSATION_GRAPHQL_QUERY,
  PULL_REQUEST_NODE_ID_GRAPHQL_QUERY,
  REACTION_SUBJECT_SCOPE_GRAPHQL_QUERY,
  REMOVE_REACTION_GRAPHQL_MUTATION,
  RESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION,
  REVIEW_THREAD_REPLY_GRAPHQL_MUTATION,
  REVIEWER_CANDIDATES_GRAPHQL_QUERY,
  UNRESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION,
  UPDATE_ISSUE_COMMENT_GRAPHQL_MUTATION,
  UPDATE_REVIEW_COMMENT_GRAPHQL_MUTATION,
} from "./gitHubPullRequestGraphql.ts";
import {
  decodeGitHubPullRequestListJson,
  GITHUB_PULL_REQUEST_LIST_CHECKS_FIELD,
  GITHUB_PULL_REQUEST_LIST_FIELDS,
} from "./gitHubPullRequestList.ts";
import { capPullRequestDiff, PULL_REQUEST_DIFF_MAX_BYTES } from "./pullRequestDiff.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderApi,
  type ProviderChangeRequestLookup,
  type ProviderRepositoryRef,
} from "./PullRequestProvider.ts";

const PROVIDER_KIND = "github" as const;
const DIFF_TIMEOUT_MS = 60_000;
/** A merge waits on the host settling its checks and its queue. */
const MERGE_TIMEOUT_MS = 60_000;
/** How long a detail read reuses the comparison with the base; see `readBaseState`. */
const BASE_STATE_HOLD_MS = 120_000;
const HELD_BASE_STATES_MAX = 200;

/** Everything GitHub lets a reader do here. The repository narrows `mergeMethods`. */
export const GITHUB_PULL_REQUEST_CAPABILITIES: PullRequestCapabilities = {
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
  updateMethods: ["merge", "rebase"],
  reactions: true,
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { pullRequest: true, comment: true },
};

/** Turns a `gh` failure into the reason the page renders an action for. */
export function classifyGitHubFailure(detail: string): PullRequestProviderError["reason"] {
  const lower = detail.toLowerCase();
  if (
    lower.includes("not available on path") ||
    lower.includes("command not found") ||
    lower.includes("enoent")
  ) {
    return "missing-tool";
  }
  if (
    lower.includes("not logged in") ||
    lower.includes("not authenticated") ||
    lower.includes("authentication") ||
    lower.includes("auth login")
  ) {
    return "unauthenticated";
  }
  if (lower.includes("rate limit")) {
    return "rate-limited";
  }
  return "failed";
}

/**
 * The line of a `gh` failure worth showing. The CLI stacks its own wrapper
 * around the host's complaint, and only the last line of that stack is the host
 * talking; a single-line failure is already that line.
 */
function lastFailureLine(detail: string): string {
  const lines = detail
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 1 ? (lines[lines.length - 1] ?? detail.trim()) : detail.trim();
}

function toProviderError(operation: string, error: GitHubCli.GitHubCliError) {
  return new PullRequestProviderError({
    provider: PROVIDER_KIND,
    operation,
    reason: classifyGitHubFailure(error.detail),
    detail: lastFailureLine(error.detail),
  });
}

function decodeError(operation: string, subject: string, failure: Cause.Cause<Schema.SchemaError>) {
  return new PullRequestProviderError({
    provider: PROVIDER_KIND,
    operation,
    reason: "failed",
    detail: `GitHub CLI returned invalid ${subject} JSON: ${formatSchemaError(failure)}`,
  });
}

/** `gh pr comment` and `gh pr review` print the new URL; nothing else is on stdout. */
function parseResultUrl(stdout: string): string | null {
  const match = stdout.match(/https?:\/\/\S+/);
  return match === null ? null : match[0];
}

/** `owner/name` split for the endpoints and GraphQL variables that need the halves. */
function repositoryParts(repository: string): { readonly owner: string; readonly name: string } {
  const [owner = "", name = ""] = repository.trim().split("/");
  return { owner, name };
}

function listFieldsFor(state: PullRequestListState): string {
  return state === "open"
    ? [...GITHUB_PULL_REQUEST_LIST_FIELDS, GITHUB_PULL_REQUEST_LIST_CHECKS_FIELD].join(",")
    : GITHUB_PULL_REQUEST_LIST_FIELDS.join(",");
}

function actionArgs(input: {
  readonly action: PullRequestAction;
  readonly mergeMethod: PullRequestMergeMethod | undefined;
  readonly updateMethod: PullRequestUpdateMethod | undefined;
  readonly deleteBranch: boolean | undefined;
}): ReadonlyArray<string> {
  switch (input.action) {
    case "merge":
      return [
        "merge",
        `--${input.mergeMethod ?? "merge"}`,
        ...(input.deleteBranch === true ? ["--delete-branch"] : []),
      ];
    // `--auto` arms the same command instead of running it, and still needs a
    // strategy: GitHub stores one with the standing instruction.
    case "enable-auto-merge":
      return ["merge", "--auto", `--${input.mergeMethod ?? "merge"}`];
    case "disable-auto-merge":
      return ["merge", "--disable-auto"];
    // `gh` updates with a merge commit unless asked to rebase, GitHub's own default.
    case "update-branch":
      return ["update-branch", ...(input.updateMethod === "rebase" ? ["--rebase"] : [])];
    case "ready":
      return ["ready"];
    // Turning a pull request back into a draft is the host's `ready --undo`.
    case "draft":
      return ["ready", "--undo"];
    case "close":
      return ["close"];
    case "reopen":
      return ["reopen"];
  }
}

/** Where the head branch stands, from the count of commits the base is ahead by. */
function toBaseComparison(behindBy: number | null): PullRequestBaseComparison {
  return behindBy === null ? "unknown" : behindBy > 0 ? "behind" : "up-to-date";
}

export const make = Effect.fn("makeGitHubPullRequestProvider")(function* () {
  const github = yield* GitHubCli.GitHubCli;
  const fileSystem = yield* FileSystem.FileSystem;

  const run = (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  }) =>
    github
      .execute({
        cwd: input.cwd,
        args: input.args,
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
      })
      .pipe(Effect.mapError((error) => toProviderError(input.operation, error)));

  /**
   * A GraphQL request. The document and its variables travel together on stdin,
   * so a reader's own words never reach argv, where they would show up in
   * process listings and inside process-runner failure messages.
   */
  const graphql = (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly query: string;
    readonly variables: Readonly<Record<string, GitHubGraphQlVariable>>;
  }) =>
    run({
      operation: input.operation,
      cwd: input.cwd,
      args: ["api", "graphql", "--input", "-"],
      stdin: encodeGraphQlRequestJson({ query: input.query, variables: input.variables }),
    });

  const graphqlRead = <A>(input: {
    readonly operation: string;
    readonly cwd: string;
    readonly query: string;
    readonly variables: Readonly<Record<string, GitHubGraphQlVariable>>;
    readonly decode: (raw: string) => Result.Result<A, Cause.Cause<Schema.SchemaError>>;
  }) =>
    graphql(input).pipe(
      Effect.flatMap((output) => {
        const decoded = input.decode(output.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(decodeError(input.operation, "GraphQL", decoded.failure));
      }),
    );

  /**
   * Fails where GitHub would merge the pull request the moment it is armed. The
   * refusal is this app's own sentence, since the host never gets asked.
   *
   * A base guarded by a merge queue is never refused: there the same call adds
   * the pull request to the queue rather than merging it, which is exactly what
   * arming means under a queue.
   */
  const refuseIfImmediatelyMergeable = (
    input: ProviderRepositoryRef & { readonly number: number },
  ) =>
    graphqlRead({
      operation: "runAction",
      cwd: input.cwd,
      query: AUTO_MERGE_READINESS_GRAPHQL_QUERY,
      variables: graphQlVariables(input),
      decode: decodeGitHubImmediatelyMergeableJson,
    }).pipe(
      Effect.flatMap((immediatelyMergeable) =>
        immediatelyMergeable
          ? Effect.fail(
              new PullRequestProviderError({
                provider: PROVIDER_KIND,
                operation: "runAction",
                reason: "failed",
                detail: "This pull request can merge right now. Use Merge instead.",
              }),
            )
          : Effect.void,
      ),
    );

  /**
   * The pictures for a set of rows, in as few requests as possible. A plain
   * login's picture is at a known URL on the host the row is on, so most rows
   * cost nothing; the accounts left over (an app account such as
   * `dependabot[bot]`) are looked up together in one request by the node id
   * `gh pr list --json author` already reports.
   *
   * A lookup that fails costs the pictures, not the listing: the client draws
   * initials wherever a picture is missing.
   */
  const withAuthorAvatars = <
    A extends {
      readonly url: string;
      readonly author: PullRequestActor | null;
      readonly authorId: string | null;
    },
  >(input: {
    readonly operation: string;
    readonly cwd: string;
    readonly rows: ReadonlyArray<A>;
  }): Effect.Effect<ReadonlyArray<A>, PullRequestProviderError> => {
    const derived = (row: A) =>
      row.author === null
        ? null
        : (row.author.avatarUrl ??
          derivedGitHubAvatarUrl({
            host: gitHubHostFromUrl(row.url),
            login: row.author.login,
            isBot: row.author.isBot,
          }));

    const ids = new Set(
      input.rows.flatMap((row) =>
        row.author !== null && row.authorId !== null && derived(row) === null ? [row.authorId] : [],
      ),
    );

    const lookup =
      ids.size === 0
        ? Effect.succeed<ReadonlyMap<string, string>>(new Map())
        : graphqlRead({
            operation: input.operation,
            cwd: input.cwd,
            query: AVATAR_NODES_GRAPHQL_QUERY,
            variables: { ids: [...ids] },
            decode: decodeGitHubAvatarNodesJson,
          }).pipe(Effect.catch(() => Effect.succeed<ReadonlyMap<string, string>>(new Map())));

    return lookup.pipe(
      Effect.map((byLogin) =>
        input.rows.map((row) => {
          const author = row.author;
          if (author === null) {
            return row;
          }
          const avatarUrl = derived(row) ?? byLogin.get(author.login.toLowerCase()) ?? null;
          return avatarUrl === author.avatarUrl
            ? row
            : { ...row, author: { ...author, avatarUrl } };
        }),
      ),
    );
  };

  /**
   * A reviewer's picture, derived from their login. GitHub reports no picture
   * with a review request, and a team is not an account the host serves one
   * for, so a team keeps none.
   */
  const withReviewerAvatar = (host: string | null) => (reviewer: PullRequestReviewer) =>
    reviewer.avatarUrl !== null || reviewer.kind !== "user"
      ? reviewer
      : {
          ...reviewer,
          avatarUrl: derivedGitHubAvatarUrl({ host, login: reviewer.login, isBot: false }),
        };

  /**
   * `gh` takes a body by path. In argv it would show up in process listings and
   * run into the command length limit.
   */
  const withBodyFile = (operation: string, body: string) =>
    fileSystem.makeTempFileScoped({ prefix: "threadlines-pr-body-", suffix: ".md" }).pipe(
      Effect.tap((filePath) => fileSystem.writeFileString(filePath, body)),
      Effect.mapError(
        (cause) =>
          new PullRequestProviderError({
            provider: PROVIDER_KIND,
            operation,
            reason: "failed",
            detail: `Failed to write the body to a temp file: ${cause.message}`,
          }),
      ),
    );

  /**
   * Every number and branch in one GraphQL request. GitHub fails the whole
   * request over one number that names no pull request, so a failure of that
   * kind is split until the number behind it stands alone, which is then
   * answered as none; the branches never cause it and go on their own.
   */
  /**
   * The base comparison a detail read reuses, by repository and number. Polling
   * an open pull request on screen reads its detail every half minute, and the
   * comparison with the base (how far behind, the merge queue) is a second
   * call that rarely moves: it is kept up to {@link BASE_STATE_HOLD_MS} while
   * the head commit and the pull request's own last update stay the same.
   * Never while it is queued or armed to merge, when the queue moves it, and
   * never for a read asked to be fresh (the Refresh control).
   */
  const heldBaseStates = new Map<
    string,
    {
      readonly head: string;
      readonly state: GitHubDetailBaseState;
      readonly readAtMs: number;
    }
  >();

  const readBaseState = (
    input: ProviderRepositoryRef & { readonly number: number; readonly fresh?: boolean },
    row: GitHubPullRequestDetailRow,
  ): Effect.Effect<GitHubDetailBaseState> =>
    Effect.gen(function* () {
      const key = `${input.repository.toLowerCase()}#${input.number}`;
      const head = `${row.headSha ?? ""}@${row.updatedAt}`;
      const nowMs = yield* Clock.currentTimeMillis;
      const held = heldBaseStates.get(key);
      const holdable =
        input.fresh !== true &&
        row.state === "open" &&
        row.autoMergeEnabled !== true &&
        row.headSha !== undefined;
      if (
        holdable &&
        held !== undefined &&
        held.head === head &&
        held.state.mergeQueue?.position == null &&
        nowMs - held.readAtMs < BASE_STATE_HOLD_MS
      ) {
        return held.state;
      }
      const state = yield* graphqlRead({
        operation: "detail",
        cwd: input.cwd,
        query: DETAIL_BASE_STATE_GRAPHQL_QUERY,
        variables: {
          ...graphQlVariables(input),
          headRef:
            row.headRepositoryOwnerLogin === null
              ? row.headBranch
              : `${row.headRepositoryOwnerLogin}:${row.headBranch}`,
        },
        decode: decodeGitHubDetailBaseStateJson,
      }).pipe(
        Effect.map((state) => ({ state, answered: true })),
        // A read the host will not answer leaves the branch's freshness
        // unknown and says nothing about a queue; it is not worth failing a
        // detail the reader can use.
        Effect.catch(() =>
          Effect.succeed({ state: { behindBy: null } as GitHubDetailBaseState, answered: false }),
        ),
      );
      heldBaseStates.delete(key);
      if (state.answered) {
        heldBaseStates.set(key, { head, state: state.state, readAtMs: nowMs });
        if (heldBaseStates.size > HELD_BASE_STATES_MAX) {
          const oldest = heldBaseStates.keys().next().value;
          if (oldest !== undefined) heldBaseStates.delete(oldest);
        }
      }
      return state.state;
    });

  const lookupChangeRequests = (
    input: ProviderRepositoryRef & {
      readonly numbers: ReadonlyArray<number>;
      readonly branches: ReadonlyArray<string>;
    },
  ): Effect.Effect<ProviderChangeRequestLookup, PullRequestProviderError> => {
    if (input.numbers.length === 0 && input.branches.length === 0) {
      return Effect.succeed({ numbers: new Map(), branches: new Map() });
    }
    const { owner, name } = repositoryParts(input.repository);
    const request = gitHubPullRequestLookupRequest({
      owner,
      name,
      numbers: input.numbers,
      branches: input.branches,
    });
    const split = (): Effect.Effect<ProviderChangeRequestLookup, PullRequestProviderError> => {
      const [first] = input.numbers;
      if (input.numbers.length === 1 && input.branches.length === 0 && first !== undefined) {
        return Effect.succeed({ numbers: new Map([[first, null]]), branches: new Map() });
      }
      const middle = Math.ceil(input.numbers.length / 2);
      const halves =
        input.branches.length > 0
          ? [
              { numbers: input.numbers, branches: [] },
              { numbers: [], branches: input.branches },
            ]
          : [
              { numbers: input.numbers.slice(0, middle), branches: [] },
              { numbers: input.numbers.slice(middle), branches: [] },
            ];
      return Effect.forEach(halves, (half) => lookupChangeRequests({ ...input, ...half })).pipe(
        Effect.map((reads) => ({
          numbers: new Map(reads.flatMap((read) => [...read.numbers])),
          branches: new Map(reads.flatMap((read) => [...read.branches])),
        })),
      );
    };
    return github
      .execute({
        cwd: input.cwd,
        args: ["api", "graphql", "--input", "-"],
        stdin: encodeGraphQlRequestJson(request),
      })
      .pipe(
        Effect.catch((error) =>
          GitHubCli.isGitHubPullRequestNotFound(error) && input.numbers.length > 0
            ? Effect.succeed(null)
            : Effect.fail(toProviderError("lookup", error)),
        ),
        Effect.flatMap((output) => {
          if (output === null) {
            return split();
          }
          const decoded = decodeGitHubPullRequestLookupJson(output.stdout.trim(), input);
          return Result.isSuccess(decoded)
            ? Effect.succeed<ProviderChangeRequestLookup>(decoded.success)
            : Effect.fail(decodeError("lookup", "GraphQL", decoded.failure));
        }),
      );
  };

  const graphQlVariables = (input: ProviderRepositoryRef & { readonly number: number }) => {
    const { owner, name } = repositoryParts(input.repository);
    return { owner, name, number: input.number };
  };

  /**
   * The pull request's own node id, which is what a mutation against the pull
   * request itself is addressed by. Read only when one is being written: the
   * conversation carries an id for every remark in it, and the pull request is
   * the one subject nothing in it names.
   */
  const pullRequestNodeId = (
    operation: string,
    input: ProviderRepositoryRef & { readonly number: number },
  ) =>
    graphqlRead({
      operation,
      cwd: input.cwd,
      query: PULL_REQUEST_NODE_ID_GRAPHQL_QUERY,
      variables: graphQlVariables(input),
      decode: decodeGitHubPullRequestNodeIdJson,
    }).pipe(
      Effect.flatMap((id) =>
        id === null
          ? Effect.fail(
              new PullRequestProviderError({
                provider: PROVIDER_KIND,
                operation,
                reason: "failed",
                detail: "GitHub did not report an id for this pull request.",
              }),
            )
          : Effect.succeed(id),
      ),
    );

  /**
   * Whether a client-given subject really belongs to the pull request the
   * request names. A subject id is trusted to be whatever node it names, and
   * that node can hang off any pull request on the host, so the mutation would
   * otherwise write wherever the id actually points.
   */
  const requireSubjectInPullRequest = (
    operation: string,
    input: ProviderRepositoryRef & { readonly number: number; readonly subjectId: string },
  ) =>
    graphqlRead({
      operation,
      cwd: input.cwd,
      query: REACTION_SUBJECT_SCOPE_GRAPHQL_QUERY,
      variables: { ...graphQlVariables(input), subjectId: input.subjectId },
      decode: decodeGitHubSubjectScopeJson,
    }).pipe(
      Effect.flatMap((belongs) =>
        belongs
          ? Effect.succeed(input.subjectId)
          : Effect.fail(
              new PullRequestProviderError({
                provider: PROVIDER_KIND,
                operation,
                reason: "failed",
                detail: "That comment does not belong to this pull request.",
              }),
            ),
      ),
    );

  const repositoryArgs = (input: ProviderRepositoryRef) => ["--repo", input.repository];

  const provider: PullRequestProviderApi = {
    kind: PROVIDER_KIND,
    capabilities: GITHUB_PULL_REQUEST_CAPABILITIES,

    getViewer: (input) =>
      run({
        operation: "getViewer",
        cwd: input.cwd,
        args: ["auth", "status", "--json", "hosts"],
      }).pipe(
        Effect.map((output): string | null => {
          const status = parseGitHubAuthStatus(output.stdout);
          const account = findAuthenticatedGitHubAccount(
            status.accounts.filter((entry) => entry.host === "github.com"),
          );
          return account?.account ?? null;
        }),
      ),

    listChangeRequests: (input) =>
      run({
        operation: "list",
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          ...repositoryArgs(input),
          "--state",
          input.state,
          "--limit",
          String(input.limit),
          "--json",
          listFieldsFor(input.state),
        ],
      }).pipe(
        Effect.flatMap((output) => {
          const raw = output.stdout.trim();
          if (raw.length === 0) {
            return Effect.succeed([]);
          }
          const decoded = decodeGitHubPullRequestListJson(raw);
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(decodeError("list", "PR list", decoded.failure));
        }),
        Effect.flatMap((rows) => withGitHubMergeQueue(github.execute, input.cwd, rows)),
        Effect.flatMap((rows) => withAuthorAvatars({ operation: "list", cwd: input.cwd, rows })),
      ),

    lookupChangeRequests: (input) => lookupChangeRequests(input),

    listAuthoredChangeRequests: (input) =>
      graphqlRead({
        operation: "listAuthored",
        cwd: input.cwd,
        query: AUTHORED_PULL_REQUESTS_GRAPHQL_QUERY,
        variables: {
          q: gitHubAuthoredSearchQuery({ viewer: input.viewer, state: input.state }),
          first: input.limit,
        },
        decode: decodeGitHubAuthoredPullRequestsJson,
      }),

    getChangeRequest: (input) =>
      run({
        operation: "detail",
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          String(input.number),
          ...repositoryArgs(input),
          "--json",
          GITHUB_PULL_REQUEST_DETAIL_FIELDS.join(","),
        ],
      }).pipe(
        Effect.flatMap((output) => {
          const decoded = decodeGitHubPullRequestDetailJson(output.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(decodeError("detail", "pull request", decoded.failure));
        }),
        Effect.flatMap((row) =>
          withAuthorAvatars({ operation: "detail", cwd: input.cwd, rows: [row] }).pipe(
            Effect.map((rows) => rows[0] ?? row),
            Effect.map((withAvatar) => ({
              ...withAvatar,
              reviewers: withAvatar.reviewers.map(
                withReviewerAvatar(gitHubHostFromUrl(withAvatar.url)),
              ),
            })),
          ),
        ),
        Effect.flatMap((row) =>
          readBaseState(input, row).pipe(
            Effect.map((base) => ({
              ...row,
              baseComparison: toBaseComparison(base.behindBy),
              behindBy: base.behindBy,
              ...(base.mergeQueue === undefined ? {} : { mergeQueue: base.mergeQueue }),
            })),
          ),
        ),
      ),

    getChangeRequestActivity: (input) =>
      Effect.all(
        [
          run({
            operation: "activity",
            cwd: input.cwd,
            args: [
              "pr",
              "view",
              String(input.number),
              ...repositoryArgs(input),
              "--json",
              GITHUB_PULL_REQUEST_ACTIVITY_FIELDS.join(","),
            ],
          }).pipe(
            Effect.flatMap((output) => {
              const decoded = decodeGitHubPullRequestActivityJson(output.stdout.trim());
              return Result.isSuccess(decoded)
                ? Effect.succeed(decoded.success)
                : Effect.fail(decodeError("activity", "activity", decoded.failure));
            }),
          ),
          graphqlRead({
            operation: "activity",
            cwd: input.cwd,
            query: PULL_REQUEST_CONVERSATION_GRAPHQL_QUERY,
            variables: graphQlVariables(input),
            decode: decodeGitHubPullRequestConversationJson,
          }),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.map(([activity, conversation]): PullRequestActivity => ({
          comments: activity.comments.map((comment): PullRequestComment => {
            const annotation = conversation.annotationsByCommentId.get(comment.id);
            return annotation === undefined
              ? comment
              : {
                  ...comment,
                  reactions: annotation.reactions,
                  viewerIsAuthor: annotation.viewerIsAuthor,
                  // The GraphQL read is the only one that names a picture.
                  author: annotation.author ?? comment.author,
                };
          }),
          commits: activity.commits,
          reviewThreads: conversation.reviewThreads,
          reactions: conversation.reactions,
        })),
      ),

    getDiff: (input) =>
      run({
        operation: "diff",
        cwd: input.cwd,
        args: ["pr", "diff", String(input.number), ...repositoryArgs(input), "--color", "never"],
        timeoutMs: DIFF_TIMEOUT_MS,
        maxOutputBytes: PULL_REQUEST_DIFF_MAX_BYTES,
      }).pipe(
        Effect.map((output) =>
          capPullRequestDiff({ patch: output.stdout, truncated: output.stdoutTruncated }),
        ),
      ),

    runAction: (input) => {
      const [subcommand = input.action, ...flags] = actionArgs({
        action: input.action,
        mergeMethod: input.mergeMethod,
        updateMethod: input.updateMethod,
        deleteBranch: input.deleteBranch,
      });
      const action = () =>
        run({
          operation: "runAction",
          cwd: input.cwd,
          args: ["pr", subcommand, String(input.number), ...repositoryArgs(input), ...flags],
          ...(input.action === "merge" ? { timeoutMs: MERGE_TIMEOUT_MS } : {}),
        }).pipe(Effect.asVoid);
      // `gh pr merge --auto` merges outright when nothing is pending, which is
      // not what someone arming a merge asked for. The readiness is read first
      // and a ready pull request is sent back to the Merge button instead.
      if (input.action === "enable-auto-merge") {
        return refuseIfImmediatelyMergeable(input).pipe(Effect.flatMap(action));
      }
      // `gh pr merge --disable-auto` stops short on a pull request the host has
      // already taken into its merge queue and leaves it there, so that case
      // is taken out of the queue by name instead.
      if (input.action === "disable-auto-merge") {
        return graphqlRead({
          operation: "runAction",
          cwd: input.cwd,
          query: MERGE_QUEUE_STANDING_GRAPHQL_QUERY,
          variables: graphQlVariables(input),
          decode: decodeGitHubMergeQueueStandingJson,
        }).pipe(
          Effect.flatMap((queuedId) =>
            queuedId === null
              ? action()
              : graphql({
                  operation: "runAction",
                  cwd: input.cwd,
                  query: DEQUEUE_PULL_REQUEST_GRAPHQL_MUTATION,
                  variables: { id: queuedId },
                }).pipe(Effect.asVoid),
          ),
        );
      }
      return action();
    },

    comment: (input) =>
      withBodyFile("comment", input.body).pipe(
        Effect.flatMap((bodyFile) =>
          run({
            operation: "comment",
            cwd: input.cwd,
            args: [
              "pr",
              "comment",
              String(input.number),
              ...repositoryArgs(input),
              "--body-file",
              bodyFile,
            ],
          }),
        ),
        Effect.map((output) => ({ url: parseResultUrl(output.stdout) })),
        Effect.scoped,
      ),

    submitReview: (input) => {
      // A review with line comments has to go as one request body: `gh pr
      // review` has no way to carry them, and nothing in the review is visible
      // to anyone else until the whole thing lands.
      if (input.comments.length > 0) {
        const { owner, name } = repositoryParts(input.repository);
        return run({
          operation: "submitReview",
          cwd: input.cwd,
          args: [
            "api",
            "--method",
            "POST",
            `repos/${owner}/${name}/pulls/${input.number}/reviews`,
            "--input",
            "-",
          ],
          stdin: buildGitHubReviewSubmissionJson({
            verdict: input.verdict,
            body: input.body,
            comments: input.comments,
          }),
        }).pipe(Effect.map((output) => ({ url: parseResultUrl(output.stdout) })));
      }

      return Effect.gen(function* () {
        const bodyArgs =
          input.body.trim().length === 0
            ? []
            : ["--body-file", yield* withBodyFile("submitReview", input.body)];
        const output = yield* run({
          operation: "submitReview",
          cwd: input.cwd,
          args: [
            "pr",
            "review",
            String(input.number),
            ...repositoryArgs(input),
            `--${input.verdict}`,
            ...bodyArgs,
          ],
        });
        return { url: parseResultUrl(output.stdout) };
      }).pipe(Effect.scoped);
    },

    replyToThread: (input) =>
      graphql({
        operation: "replyToThread",
        cwd: input.cwd,
        query: REVIEW_THREAD_REPLY_GRAPHQL_MUTATION,
        variables: { threadId: input.threadId, body: input.body },
      }).pipe(Effect.asVoid),

    setThreadResolution: (input) =>
      graphql({
        operation: "setThreadResolution",
        cwd: input.cwd,
        query: input.resolved
          ? RESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION
          : UNRESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION,
        variables: { threadId: input.threadId },
      }).pipe(Effect.asVoid),

    setReaction: (input) => {
      const given = input.subjectId;
      const subjectId =
        given === undefined
          ? pullRequestNodeId("setReaction", input)
          : requireSubjectInPullRequest("setReaction", { ...input, subjectId: given });
      return subjectId.pipe(
        Effect.flatMap((resolved) =>
          graphql({
            operation: "setReaction",
            cwd: input.cwd,
            query: input.reacted ? ADD_REACTION_GRAPHQL_MUTATION : REMOVE_REACTION_GRAPHQL_MUTATION,
            variables: { subjectId: resolved, content: gitHubReactionContent(input.content) },
          }),
        ),
        Effect.asVoid,
      );
    },

    updateChangeRequest: (input) =>
      Effect.gen(function* () {
        const bodyArgs =
          input.body === undefined
            ? []
            : ["--body-file", yield* withBodyFile("update", input.body)];
        yield* run({
          operation: "update",
          cwd: input.cwd,
          args: [
            "pr",
            "edit",
            String(input.number),
            ...repositoryArgs(input),
            ...(input.title === undefined ? [] : ["--title", input.title]),
            ...bodyArgs,
          ],
        });
      }).pipe(Effect.scoped),

    updateComment: (input) =>
      requireSubjectInPullRequest("updateComment", {
        ...input,
        subjectId: input.commentId,
      }).pipe(
        Effect.flatMap((commentId) =>
          graphql({
            operation: "updateComment",
            cwd: input.cwd,
            query:
              input.kind === "issue-comment"
                ? UPDATE_ISSUE_COMMENT_GRAPHQL_MUTATION
                : UPDATE_REVIEW_COMMENT_GRAPHQL_MUTATION,
            variables: { commentId, body: input.body },
          }),
        ),
        Effect.asVoid,
      ),

    listReviewerCandidates: (input) =>
      graphqlRead({
        operation: "reviewerCandidates",
        cwd: input.cwd,
        query: REVIEWER_CANDIDATES_GRAPHQL_QUERY,
        variables: graphQlVariables(input),
        decode: decodeGitHubReviewerCandidatesJson,
      }),

    setReviewerRequest: (input) => {
      const { owner, name } = repositoryParts(input.repository);
      return run({
        operation: "requestReviewers",
        cwd: input.cwd,
        // GitHub takes a request back from exactly whoever it was made of, so
        // the same body serves both methods.
        args: [
          "api",
          "--method",
          input.requested ? "POST" : "DELETE",
          `repos/${owner}/${name}/pulls/${input.number}/requested_reviewers`,
          "--input",
          "-",
        ],
        stdin: buildGitHubReviewerRequestJson(input.reviewers),
      }).pipe(Effect.asVoid);
    },

    getRepositoryAccess: (input) =>
      run({
        operation: "repository",
        cwd: input.cwd,
        args: ["api", `repos/${input.repository}`],
      }).pipe(
        Effect.flatMap((output) => {
          const decoded = decodeGitHubRepositoryJson(output.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(decodeError("repository", "repository", decoded.failure));
        }),
      ),
  };

  return provider;
});
