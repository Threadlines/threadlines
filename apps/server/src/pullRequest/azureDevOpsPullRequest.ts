import type * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  TrimmedNonEmptyString,
  type PullRequestActor,
  type PullRequestComment,
  type PullRequestMergeability,
  type PullRequestReviewer,
  type PullRequestState,
} from "@threadlines/contracts";
import { decodeJsonResult } from "@threadlines/shared/schemaJson";

import {
  azureDevOpsOrganizationBaseFromRestApiUrl,
  azureDevOpsPullRequestWebUrl,
} from "../sourceControl/azureDevOpsPullRequests.ts";

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

/**
 * Azure's enums are decoded as plain strings and normalized here, in the same
 * tolerant style as the other hosts. Every field beyond the identity is
 * optional, because `az repos pr` returns rather more or less of the REST
 * object depending on the command.
 */
const AzureIdentitySchema = Schema.Struct({
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  /** An email or UPN, which is what `az account show` reports for the viewer. */
  uniqueName: Schema.optional(Schema.NullOr(Schema.String)),
  /** How `az repos pr reviewer` names one, when Azure carries it. */
  id: Schema.optional(Schema.NullOr(Schema.String)),
  /** Azure's picture for the identity, which is not always a plain URL. */
  imageUrl: Schema.optional(Schema.NullOr(Schema.String)),
  vote: Schema.optional(Schema.NullOr(Schema.Int)),
});

const AzurePullRequestSchema = Schema.Struct({
  pullRequestId: Schema.Int,
  title: TrimmedNonEmptyString,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /**
   * Who armed auto-complete, which is all Azure says about it: the field
   * carries an identity while the pull request is set to complete on its own,
   * and Azure leaves it out entirely once nobody has.
   */
  autoCompleteSetBy: Schema.optional(Schema.NullOr(AzureIdentitySchema)),
  mergeStatus: Schema.optional(Schema.NullOr(Schema.String)),
  createdBy: Schema.optional(Schema.NullOr(AzureIdentitySchema)),
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(AzureIdentitySchema))),
  // Required, and required to be non-empty: the wire contract will not carry a
  // pull request without a branch or a created time, so a row missing one is
  // skipped rather than breaking the response it travels in.
  sourceRefName: TrimmedNonEmptyString,
  targetRefName: TrimmedNonEmptyString,
  creationDate: TrimmedNonEmptyString,
  closedDate: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  repository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.optional(Schema.NullOr(Schema.String)),
        webUrl: Schema.optional(Schema.NullOr(Schema.String)),
        project: Schema.optional(
          Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) })),
        ),
      }),
    ),
  ),
  _links: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        web: Schema.optional(
          Schema.NullOr(Schema.Struct({ href: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  ),
});

/** A pull request thread, which is how Azure keeps its conversation. */
const AzureThreadSchema = Schema.Struct({
  id: Schema.Int,
  isDeleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
  threadContext: Schema.optional(
    Schema.NullOr(Schema.Struct({ filePath: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  comments: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          id: Schema.optional(Schema.NullOr(Schema.Int)),
          content: Schema.optional(Schema.NullOr(Schema.String)),
          author: Schema.optional(Schema.NullOr(AzureIdentitySchema)),
          publishedDate: Schema.optional(Schema.NullOr(Schema.String)),
          isDeleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
          /** `system` marks the notes Azure writes itself, which are events. */
          commentType: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
});

const AzureThreadPageSchema = Schema.Struct({ value: Schema.Array(Schema.Unknown) });

const AzureViewerSchema = Schema.Struct({
  user: Schema.optional(
    Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

const AzureRepositorySchema = Schema.Struct({
  defaultBranch: Schema.optional(Schema.NullOr(Schema.String)),
});

/** One decoded pull request, before the service attaches its project. */
export interface AzureDevOpsPullRequestRow {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly createdAt: string;
  /**
   * Azure records no last-touched time on a pull request, so its closing time
   * stands in where there is one and its creation time otherwise.
   */
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly body: string;
  readonly reviewRequestedLogins: ReadonlyArray<string>;
  readonly reviewers: ReadonlyArray<PullRequestReviewer>;
  /** Where this pull request's threads live, when Azure said enough to say. */
  readonly threadsUrl: string | null;
  /** Whether Azure is set to complete this on its own once its policies pass. */
  readonly autoMergeEnabled: boolean;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function normalizeRefName(refName: string): string {
  return refName.trim().replace(/^refs\/heads\//, "");
}

/**
 * The picture Azure named, if it is one a browser can fetch on its own. Azure
 * writes a relative path or a `data:` blob as readily as a URL, and only an
 * absolute http one is worth handing the client; the rest draw initials.
 */
function toAvatarUrl(value: string | null | undefined): string | null {
  const raw = trimmed(value);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? raw : null;
  } catch {
    return null;
  }
}

/** A login has to compare against `az account show`, which reports an email. */
function toActor(
  raw: Schema.Schema.Type<typeof AzureIdentitySchema> | null | undefined,
): PullRequestActor | null {
  const login = trimmed(raw?.uniqueName) ?? trimmed(raw?.displayName);
  // Azure names no bot flag on the identities it hands back.
  return login === null ? null : { login, isBot: false, avatarUrl: toAvatarUrl(raw?.imageUrl) };
}

function toState(raw: Schema.Schema.Type<typeof AzurePullRequestSchema>): PullRequestState {
  switch (raw.status?.trim().toLowerCase()) {
    case "completed":
      return "merged";
    case "abandoned":
      return "closed";
    default:
      return "open";
  }
}

function toMergeability(value: string | null | undefined): PullRequestMergeability {
  switch (value?.trim().toLowerCase()) {
    case "succeeded":
      return "mergeable";
    case "conflicts":
    case "failure":
    case "rejectedbypolicy":
      return "conflicting";
    default:
      // `queued` and `notSet` mean Azure has not finished checking.
      return "unknown";
  }
}

/**
 * Azure records a reviewer's verdict as a vote: 10 and 5 approve, -5 waits for
 * the author, -10 rejects, and 0 means they have not voted yet.
 */
function toReviewerState(vote: number | null | undefined): PullRequestReviewer["state"] {
  if (vote === undefined || vote === null || vote === 0) {
    return "pending";
  }
  if (vote > 0) {
    return "approved";
  }
  return vote <= -10 ? "changes-requested" : "commented";
}

/**
 * The REST collection a pull request's threads hang from. Built from what Azure
 * returned rather than from the local remote, whose shape differs between the
 * modern, legacy and SSH forms.
 */
function toThreadsUrl(raw: Schema.Schema.Type<typeof AzurePullRequestSchema>): string | null {
  const base = azureDevOpsOrganizationBaseFromRestApiUrl(raw.url);
  const project = trimmed(raw.repository?.project?.name);
  const repository = trimmed(raw.repository?.name);
  if (base === null || project === null || repository === null) {
    return null;
  }
  return `${base}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(
    repository,
  )}/pullRequests/${raw.pullRequestId}/threads`;
}

/**
 * Null when Azure said too little to place the pull request: a row with no
 * browser url and no branch left after its prefix is dropped cannot be rendered
 * or opened, and the wire contract refuses to carry it either.
 */
function toRow(
  raw: Schema.Schema.Type<typeof AzurePullRequestSchema>,
): AzureDevOpsPullRequestRow | null {
  const url = trimmed(
    azureDevOpsPullRequestWebUrl({
      pullRequestId: raw.pullRequestId,
      webLink: raw._links?.web?.href,
      repositoryWebUrl: raw.repository?.webUrl,
      restApiUrl: raw.url,
      projectName: raw.repository?.project?.name,
      repositoryName: raw.repository?.name,
    }),
  );
  const headBranch = trimmed(normalizeRefName(raw.sourceRefName));
  const baseBranch = trimmed(normalizeRefName(raw.targetRefName));
  if (url === null || headBranch === null || baseBranch === null) {
    return null;
  }

  const reviewers = (raw.reviewers ?? []).flatMap(
    (reviewer): ReadonlyArray<PullRequestReviewer> => {
      const actor = toActor(reviewer);
      return actor === null
        ? []
        : [
            {
              // Azure names an identity by an email or a guid, and takes either.
              id: trimmed(reviewer.id) ?? actor.login,
              kind: "user",
              login: actor.login,
              state: toReviewerState(reviewer.vote),
              avatarUrl: actor.avatarUrl,
            },
          ];
    },
  );
  const closedAt = trimmed(raw.closedDate);

  return {
    number: raw.pullRequestId,
    title: raw.title,
    url,
    author: toActor(raw.createdBy),
    headBranch,
    baseBranch,
    state: toState(raw),
    isDraft: raw.isDraft === true,
    mergeability: toMergeability(raw.mergeStatus),
    createdAt: raw.creationDate,
    updatedAt: closedAt ?? raw.creationDate,
    closedAt,
    body: raw.description ?? "",
    reviewRequestedLogins: reviewers
      .filter((reviewer) => reviewer.state === "pending")
      .map((reviewer) => reviewer.login),
    reviewers,
    threadsUrl: toThreadsUrl(raw),
    autoMergeEnabled: (raw.autoCompleteSetBy ?? null) !== null,
  };
}

const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodePullRequestEntry = Schema.decodeUnknownExit(AzurePullRequestSchema);
const decodePullRequest = decodeJsonResult(AzurePullRequestSchema);
const decodeThreadPage = decodeJsonResult(AzureThreadPageSchema);
const decodeThreadEntry = Schema.decodeUnknownExit(AzureThreadSchema);
const decodeViewer = decodeJsonResult(AzureViewerSchema);
const decodeRepository = decodeJsonResult(AzureRepositorySchema);

/** Malformed entries are skipped rather than failing the batch. */
export function decodeAzureDevOpsPullRequestListJson(
  raw: string,
): Result.Result<ReadonlyArray<AzureDevOpsPullRequestRow>, DecodeFailure> {
  const payload = decodeUnknownList(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  const rows: AzureDevOpsPullRequestRow[] = [];
  for (const entry of payload.success) {
    const decoded = decodePullRequestEntry(entry);
    if (Exit.isFailure(decoded)) {
      continue;
    }
    const row = toRow(decoded.value);
    if (row !== null) {
      rows.push(row);
    }
  }
  return Result.succeed(rows);
}

/** Null carries "Azure answered, but with too little to use". */
export function decodeAzureDevOpsPullRequestJson(
  raw: string,
): Result.Result<AzureDevOpsPullRequestRow | null, DecodeFailure> {
  const payload = decodePullRequest(raw);
  return Result.isSuccess(payload)
    ? Result.succeed(toRow(payload.success))
    : Result.fail(payload.failure);
}

/** `az account show --query user` reports the viewer, whose name is an email. */
export function decodeAzureDevOpsViewerJson(
  raw: string,
): Result.Result<string | null, DecodeFailure> {
  const payload = decodeViewer(raw);
  return Result.isSuccess(payload)
    ? Result.succeed(trimmed(payload.success.user?.name))
    : Result.fail(payload.failure);
}

export function decodeAzureDevOpsRepositoryJson(
  raw: string,
): Result.Result<string | null, DecodeFailure> {
  const payload = decodeRepository(raw);
  return Result.isSuccess(payload)
    ? Result.succeed(trimmed(normalizeRefName(payload.success.defaultBranch ?? "")))
    : Result.fail(payload.failure);
}

/**
 * Azure keeps its conversation as threads of comments, and every one of them is
 * a remark somebody wrote: a reply under a thread is as much of the conversation
 * as the line that opened it. Azure answers the whole collection in one
 * response, with no cursor and no page to follow.
 *
 * A thread pinned to a file is a line remark, and this host cannot show a diff
 * to pin it to, so it joins the conversation like any other.
 */
export function decodeAzureDevOpsThreadsJson(
  raw: string,
  viewer: string | null,
): Result.Result<ReadonlyArray<PullRequestComment>, DecodeFailure> {
  const payload = decodeThreadPage(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  const viewerLogin = viewer?.toLowerCase() ?? null;
  const comments: PullRequestComment[] = [];
  for (const entry of payload.success.value) {
    const decoded = decodeThreadEntry(entry);
    if (Exit.isFailure(decoded)) {
      continue;
    }
    const thread = decoded.value;
    if (thread.isDeleted === true) {
      continue;
    }
    for (const comment of thread.comments ?? []) {
      const publishedDate = trimmed(comment.publishedDate);
      if (
        comment.isDeleted === true ||
        comment.commentType?.trim().toLowerCase() === "system" ||
        (comment.content ?? "").trim().length === 0 ||
        publishedDate === null
      ) {
        continue;
      }
      const author = toActor(comment.author);
      comments.push({
        id: `${thread.id}:${comment.id ?? 0}`,
        kind: "issue-comment",
        author,
        body: comment.content ?? "",
        createdAt: publishedDate,
        url: null,
        reviewState: null,
        // Azure DevOps has no reaction on a pull request comment.
        reactions: [],
        viewerIsAuthor: viewerLogin !== null && author?.login.toLowerCase() === viewerLogin,
      });
    }
  }
  return Result.succeed(
    comments.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
  );
}
