import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";

import type {
  PullRequestAction,
  PullRequestActivity,
  PullRequestCapabilities,
  PullRequestListState,
  PullRequestMergeMethod,
} from "@threadlines/contracts";
import { formatSchemaError } from "@threadlines/shared/schemaJson";

import type * as AzureDevOpsCliModule from "../sourceControl/AzureDevOpsCli.ts";
import { AzureDevOpsCli } from "../sourceControl/AzureDevOpsCli.ts";
import {
  decodeAzureDevOpsPullRequestJson,
  decodeAzureDevOpsPullRequestListJson,
  decodeAzureDevOpsRepositoryJson,
  decodeAzureDevOpsThreadsJson,
  decodeAzureDevOpsViewerJson,
  type AzureDevOpsPullRequestRow,
} from "./azureDevOpsPullRequest.ts";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";

const PROVIDER_KIND = "azure-devops" as const;
/** The REST version the threads read is pinned to; `az rest` sends no default. */
const REST_API_VERSION = "7.1";
/** A merge waits on Azure settling its branch policies. */
const MERGE_TIMEOUT_MS = 60_000;

/**
 * Everything Azure DevOps lets a reader do here. `az repos pr` has no diff
 * command and the REST route reports changed files without their contents, so
 * there is no patch to show and the Code tab is hidden rather than empty.
 * Reading a conversation is a plain REST read, but nothing in `az repos pr`
 * posts one, so the composer stays hidden too.
 */
export const AZURE_DEVOPS_PULL_REQUEST_CAPABILITIES: PullRequestCapabilities = {
  diff: false,
  comment: false,
  actions: [
    "merge",
    "close",
    "reopen",
    "ready",
    "draft",
    "enable-auto-merge",
    "disable-auto-merge",
  ],
  // Azure squashes as a completion option; it has no rebase strategy of its own.
  mergeMethods: ["merge", "squash"],
  updateMethods: [],
  reactions: false,
  // With no patch to show there are no lines to write against, so nothing here
  // is offered.
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  // `az repos pr reviewer add` and `remove` name identities, and nothing in
  // `az repos` lists the ones a repository could name: that lives behind the
  // identity and graph APIs, a different service with its own permissions. So
  // the page takes a name here rather than a menu built out of a guess.
  reviewers: { request: true, listCandidates: false },
  // A new title and description travel on the same `az repos pr update` that
  // moves a pull request. Rewriting a remark is false for the reason posting one
  // is: nothing here can put a remark on Azure DevOps to rewrite.
  edit: { pullRequest: true, comment: false },
};

/** Turns an `az` failure into the reason the page renders an action for. */
export function classifyAzureDevOpsFailure(detail: string): PullRequestProviderError["reason"] {
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
    lower.includes("az devops login") ||
    lower.includes("az login") ||
    lower.includes("not logged in") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication")
  ) {
    return "unauthenticated";
  }
  if (lower.includes("rate limit") || lower.includes("too many requests")) {
    return "rate-limited";
  }
  return "failed";
}

/** The line of an `az` failure worth showing; the CLI stacks its own wrapper. */
function lastFailureLine(detail: string): string {
  const lines = detail
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 1 ? (lines[lines.length - 1] ?? detail.trim()) : detail.trim();
}

function toProviderError(operation: string, error: AzureDevOpsCliModule.AzureDevOpsCliError) {
  return new PullRequestProviderError({
    provider: PROVIDER_KIND,
    operation,
    reason: classifyAzureDevOpsFailure(error.detail),
    detail: lastFailureLine(error.detail),
  });
}

function decodeError(operation: string, subject: string, failure: Cause.Cause<Schema.SchemaError>) {
  return new PullRequestProviderError({
    provider: PROVIDER_KIND,
    operation,
    reason: "failed",
    detail: `Azure DevOps CLI returned invalid ${subject} JSON: ${formatSchemaError(failure)}`,
  });
}

/** Refuses a call this host declares it cannot make, should one ever reach it. */
function unsupported(operation: string, detail: string) {
  return Effect.fail(
    new PullRequestProviderError({
      provider: PROVIDER_KIND,
      operation,
      reason: "failed",
      detail,
    }),
  );
}

function statusArgs(state: PullRequestListState): ReadonlyArray<string> {
  switch (state) {
    case "open":
      return ["--status", "active"];
    case "merged":
      return ["--status", "completed"];
    case "closed":
      return ["--status", "abandoned"];
  }
}

/**
 * Azure moves a pull request by setting its state rather than by named
 * commands: completing it is the merge, abandoning it the close, and
 * reactivating it the reopen. Squashing is a completion option of its own.
 */
function actionArgs(
  action: PullRequestAction,
  mergeMethod: PullRequestMergeMethod | undefined,
): ReadonlyArray<string> {
  const squash = ["--squash", mergeMethod === "squash" ? "true" : "false"];
  switch (action) {
    case "merge":
      return ["--status", "completed", ...squash];
    // Auto-complete is Azure's own name for it: the pull request stays active
    // and Azure completes it once its policies pass, with the squash choice
    // stored alongside as it is for a merge now.
    case "enable-auto-merge":
      return ["--auto-complete", "true", ...squash];
    case "disable-auto-merge":
      return ["--auto-complete", "false"];
    case "ready":
      return ["--draft", "false"];
    case "draft":
      return ["--draft", "true"];
    case "close":
      return ["--status", "abandoned"];
    case "reopen":
      return ["--status", "active"];
    // Never reached: this host does not declare the action, so nothing offers it.
    case "update-branch":
      return [];
  }
}

/**
 * A reviewer Azure could be given: an email address, a display name or an
 * identity guid, and nothing that starts with a dash. The dash is the point:
 * these are argv, and a value shaped like a flag would become one.
 */
function isReviewerName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && !trimmed.startsWith("-");
}

/**
 * `az repos pr list` names a repository by its own name and takes the
 * organization and project from the checkout it detects, so the recorded path's
 * last segment is what it is handed.
 */
function repositoryName(repository: string): string {
  const segments = repository
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== "_git");
  return segments.at(-1) ?? repository.trim();
}

export const make = Effect.fn("makeAzureDevOpsPullRequestProvider")(function* () {
  const azure = yield* AzureDevOpsCli;

  // `--detect true` reads the organization, project and repository from the
  // checkout's own remote, which is the only place `az repos` learns all three.
  const detectArgs = ["--detect", "true"] as const;

  const run = (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs?: number;
  }) =>
    azure
      .execute({
        cwd: input.cwd,
        args: [...input.args, "--only-show-errors", "--output", "json"],
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      })
      .pipe(Effect.mapError((error) => toProviderError(input.operation, error)));

  const read = <A>(input: {
    readonly operation: string;
    readonly subject: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly decode: (raw: string) => Result.Result<A, Cause.Cause<Schema.SchemaError>>;
  }) =>
    run(input).pipe(
      Effect.flatMap((output) => {
        const decoded = input.decode(output.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(decodeError(input.operation, input.subject, decoded.failure));
      }),
    );

  const readViewer = (operation: string, cwd: string) =>
    run({ operation, cwd, args: ["account", "show", "--query", "user"] }).pipe(
      Effect.flatMap((output) => {
        // `--query user` narrows the payload to the account, so it is nested
        // back under the key the decoder reads to keep one shape for the viewer.
        const decoded = decodeAzureDevOpsViewerJson(`{"user":${output.stdout.trim() || "null"}}`);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(decodeError(operation, "account", decoded.failure));
      }),
    );

  const readPullRequest = (
    operation: string,
    input: { readonly cwd: string; readonly number: number },
  ) =>
    read({
      operation,
      subject: "pull request",
      cwd: input.cwd,
      args: ["repos", "pr", "show", ...detectArgs, "--id", String(input.number)],
      decode: decodeAzureDevOpsPullRequestJson,
    }).pipe(
      Effect.flatMap((row) =>
        row === null
          ? Effect.fail(
              new PullRequestProviderError({
                provider: PROVIDER_KIND,
                operation,
                reason: "failed",
                detail: "Azure DevOps said too little about this pull request to show it.",
              }),
            )
          : Effect.succeed(row),
      ),
    );

  const toChangeRequest = (row: AzureDevOpsPullRequestRow): ProviderChangeRequest => ({
    number: row.number,
    title: row.title,
    url: row.url,
    author: row.author,
    headBranch: row.headBranch,
    baseBranch: row.baseBranch,
    state: row.state,
    isDraft: row.isDraft,
    // Azure reports no line counts on a pull request, and with no patch to read
    // there is nothing to count them from either.
    additions: 0,
    deletions: 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    reviewRequestedLogins: row.reviewRequestedLogins,
    // Azure keeps labels on work items rather than on the pull request.
    labels: [],
    autoMergeEnabled: row.autoMergeEnabled,
  });

  const provider: PullRequestProviderApi = {
    kind: PROVIDER_KIND,
    capabilities: AZURE_DEVOPS_PULL_REQUEST_CAPABILITIES,

    getViewer: (input) => readViewer("getViewer", input.cwd),

    listChangeRequests: (input) =>
      read({
        operation: "list",
        subject: "PR list",
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "list",
          ...detectArgs,
          "--repository",
          repositoryName(input.repository),
          ...statusArgs(input.state),
          // A web link per row, which is the only url that needs no assembling.
          "--include-links",
          "--top",
          String(input.limit),
        ],
        decode: decodeAzureDevOpsPullRequestListJson,
      }).pipe(Effect.map((rows) => rows.map(toChangeRequest))),

    getChangeRequest: (input) =>
      readPullRequest("detail", input).pipe(
        Effect.map((row) => ({
          ...toChangeRequest(row),
          body: row.body,
          // Azure reports the files a pull request touches only through a
          // separate iteration read, which is not worth a request for a count.
          changedFiles: 0,
          mergeability: row.mergeability,
          mergedAt: row.state === "merged" ? row.closedAt : null,
          closedAt: row.state === "closed" ? row.closedAt : null,
          reviewers: row.reviewers,
          // Azure keeps its build results on branch policies rather than on the
          // pull request, which `az repos pr` does not reach.
          checks: [],
          baseComparison: "unknown" as const,
          behindBy: null,
        })),
      ),

    getChangeRequestActivity: (input) =>
      Effect.gen(function* () {
        const [row, viewer] = yield* Effect.all(
          [
            readPullRequest("activity", input),
            readViewer("activity", input.cwd).pipe(
              Effect.catch(() => Effect.succeed<string | null>(null)),
            ),
          ],
          { concurrency: 2 },
        );
        // A pull request Azure said too little about carries no thread
        // collection to read, which leaves the conversation empty rather than
        // failing the read.
        const comments =
          row.threadsUrl === null
            ? []
            : yield* read({
                operation: "activity",
                subject: "threads",
                cwd: input.cwd,
                args: [
                  "rest",
                  "--method",
                  "get",
                  "--url",
                  `${row.threadsUrl}?api-version=${REST_API_VERSION}`,
                ],
                decode: (raw) => decodeAzureDevOpsThreadsJson(raw, viewer),
              }).pipe(Effect.catch(() => Effect.succeed([])));

        return {
          comments,
          // Azure lists a pull request's commits behind an iteration read, which
          // `az repos pr` does not reach.
          commits: [],
          reviewThreads: [],
          reactions: [],
        } satisfies PullRequestActivity;
      }),

    // Never called: `capabilities.diff` is false, and the service refuses a diff
    // without it. These exist because every provider answers the whole port.
    getDiff: () =>
      unsupported("getDiff", "Azure DevOps cannot produce a patch for a pull request."),

    runAction: (input) =>
      run({
        operation: "runAction",
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "update",
          ...detectArgs,
          "--id",
          String(input.number),
          ...actionArgs(input.action, input.mergeMethod),
        ],
        ...(input.action === "merge" ? { timeoutMs: MERGE_TIMEOUT_MS } : {}),
      }).pipe(Effect.asVoid),

    comment: () => unsupported("comment", "Azure DevOps comments cannot be written from here yet."),

    submitReview: () =>
      unsupported("submitReview", "Azure DevOps reviews cannot be written from here yet."),

    replyToThread: () =>
      unsupported("replyToThread", "Azure DevOps reviews cannot be written from here yet."),

    setThreadResolution: () =>
      unsupported("setThreadResolution", "Azure DevOps reviews cannot be written from here yet."),

    setReaction: () => unsupported("setReaction", "Azure DevOps does not support reactions."),

    updateChangeRequest: (input) =>
      run({
        operation: "update",
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "update",
          ...detectArgs,
          "--id",
          String(input.number),
          // One argument rather than a flag and a value beside it: a description
          // usually opens with a bullet, and `az` reads a dash in the next argv
          // slot as a flag of its own.
          ...(input.title === undefined ? [] : [`--title=${input.title}`]),
          ...(input.body === undefined ? [] : [`--description=${input.body}`]),
        ],
      }).pipe(Effect.asVoid),

    updateComment: () =>
      unsupported("updateComment", "Azure DevOps comments cannot be written from here yet."),

    listReviewerCandidates: () =>
      unsupported(
        "listReviewerCandidates",
        "Azure DevOps cannot say who may review a pull request.",
      ),

    setReviewerRequest: (input) => {
      const reviewers = input.reviewers.map((reviewer) => reviewer.id);
      return reviewers.some((reviewer) => !isReviewerName(reviewer))
        ? unsupported(
            "requestReviewers",
            "Azure DevOps takes a reviewer's email address, display name or id.",
          )
        : run({
            operation: "requestReviewers",
            cwd: input.cwd,
            args: [
              "repos",
              "pr",
              "reviewer",
              input.requested ? "add" : "remove",
              ...detectArgs,
              "--id",
              String(input.number),
              // One `--reviewers` takes them all, because `az` reads the flag as
              // a list and a second one would replace the first.
              "--reviewers",
              ...reviewers,
            ],
          }).pipe(Effect.asVoid);
    },

    /**
     * Azure states no permission anywhere `az repos pr` reaches: the answer
     * lives in the security namespaces, behind identity descriptors and token
     * paths that would be several calls per pull request. So write access is
     * granted and Azure refuses at the moment somebody tries, which is the safer
     * half of an unknown: hiding a control from whoever is entitled to it leaves
     * them no way through and no reason given.
     */
    getRepositoryAccess: (input) =>
      read({
        operation: "repository",
        subject: "repository",
        cwd: input.cwd,
        args: ["repos", "show", ...detectArgs, "--repository", repositoryName(input.repository)],
        decode: decodeAzureDevOpsRepositoryJson,
      }).pipe(
        Effect.map((defaultBranch) => ({
          canWrite: true,
          mergeMethods: AZURE_DEVOPS_PULL_REQUEST_CAPABILITIES.mergeMethods,
          defaultBranch,
        })),
      ),
  };

  return provider;
});
