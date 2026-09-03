import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  TrimmedNonEmptyString,
  type PullRequestActor,
  type PullRequestCheck,
  type PullRequestCheckStatus,
  type PullRequestComment,
  type PullRequestCommit,
  type PullRequestMergeability,
  type PullRequestMergeMethod,
  type PullRequestReviewCommentDraft,
  type PullRequestReviewerCandidate,
  type PullRequestReviewPosition,
  type PullRequestReviewState,
  type PullRequestReviewThread,
  type PullRequestState,
} from "@threadlines/contracts";
import { decodeJsonResult } from "@threadlines/shared/schemaJson";

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

/**
 * Bitbucket's enums are decoded as plain strings and normalized here, in the
 * same tolerant style as the GitHub and GitLab decoders: a new pull request
 * state or build status must not fail a whole payload.
 */
const BitbucketUserSchema = Schema.Struct({
  /**
   * How Bitbucket addresses an account when a reviewer set is written; the
   * handles it shows are not accepted there. Braced, and sent back exactly as
   * it arrived.
   */
  uuid: Schema.optional(Schema.NullOr(Schema.String)),
  /** Absent on an app account, which is why `display_name` stands in for it. */
  nickname: Schema.optional(Schema.NullOr(Schema.String)),
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * Required, and required to be non-empty: the wire contract will not carry a
 * pull request without a branch or a link, so a row missing one is skipped
 * rather than breaking the response it travels in.
 */
const BitbucketBranchSchema = Schema.Struct({
  branch: Schema.Struct({ name: TrimmedNonEmptyString }),
});

const BitbucketPullRequestSchema = Schema.Struct({
  id: Schema.Int,
  title: TrimmedNonEmptyString,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  author: Schema.optional(Schema.NullOr(BitbucketUserSchema)),
  source: BitbucketBranchSchema,
  destination: BitbucketBranchSchema,
  created_on: TrimmedNonEmptyString,
  updated_on: TrimmedNonEmptyString,
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(BitbucketUserSchema))),
  participants: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          user: Schema.optional(Schema.NullOr(BitbucketUserSchema)),
          approved: Schema.optional(Schema.NullOr(Schema.Boolean)),
          state: Schema.optional(Schema.NullOr(Schema.String)),
          participated_on: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
  links: Schema.Struct({ html: Schema.Struct({ href: TrimmedNonEmptyString }) }),
});

const BitbucketPageSchema = Schema.Struct({
  values: Schema.Array(Schema.Unknown),
  /** Present only while a further page exists. */
  next: Schema.optional(Schema.NullOr(Schema.String)),
});

const BitbucketCommentSchema = Schema.Struct({
  id: Schema.Int,
  content: Schema.optional(Schema.NullOr(Schema.Struct({ raw: Schema.optional(Schema.String) }))),
  user: Schema.optional(Schema.NullOr(BitbucketUserSchema)),
  created_on: TrimmedNonEmptyString,
  deleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /** A comment its author has not posted yet. */
  pending: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /** Set on a reply, to the comment it answers, which may itself be a reply. */
  parent: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.Int }))),
  inline: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        path: Schema.optional(Schema.NullOr(Schema.String)),
        /** The line in the file as it was; set instead of `to` on a removed line. */
        from: Schema.optional(Schema.NullOr(Schema.Int)),
        /** The line in the file as it is now. */
        to: Schema.optional(Schema.NullOr(Schema.Int)),
        outdated: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
  /** Non-null once somebody has marked the thread resolved. */
  resolution: Schema.optional(Schema.NullOr(Schema.Unknown)),
  links: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        html: Schema.optional(
          Schema.NullOr(Schema.Struct({ href: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  ),
});

const BitbucketCommitSchema = Schema.Struct({
  hash: TrimmedNonEmptyString,
  message: Schema.optional(Schema.NullOr(Schema.String)),
  date: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        raw: Schema.optional(Schema.NullOr(Schema.String)),
        user: Schema.optional(Schema.NullOr(BitbucketUserSchema)),
      }),
    ),
  ),
});

const BitbucketStatusSchema = Schema.Struct({
  key: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

const BitbucketDiffStatSchema = Schema.Struct({
  lines_added: Schema.optional(Schema.NullOr(Schema.Int)),
  lines_removed: Schema.optional(Schema.NullOr(Schema.Int)),
});

/** One row of `/workspaces/{workspace}/members`, which wraps the account. */
const BitbucketMemberSchema = Schema.Struct({
  user: Schema.optional(Schema.NullOr(BitbucketUserSchema)),
});

const BitbucketViewerSchema = Schema.Struct({
  nickname: Schema.optional(Schema.NullOr(Schema.String)),
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * `/user/permissions/repositories` narrowed to one repository, which is the
 * only place Bitbucket states what the credentials may do with it.
 */
const BitbucketRepositoryPermissionsSchema = Schema.Struct({
  values: Schema.optional(
    Schema.NullOr(
      Schema.Array(Schema.Struct({ permission: Schema.optional(Schema.NullOr(Schema.String)) })),
    ),
  ),
});

const BitbucketRepositorySchema = Schema.Struct({
  mainbranch: Schema.optional(
    Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

/** One decoded pull request, before the service attaches its project. */
export interface BitbucketPullRequestRow {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly body: string;
  readonly reviewRequestedLogins: ReadonlyArray<string>;
  /** The reviewers as Bitbucket addresses them, which is what a write takes. */
  readonly reviewers: ReadonlyArray<{ readonly id: string; readonly login: string }>;
  /** Approvals and change requests, which Bitbucket keeps on its participants. */
  readonly reviews: ReadonlyArray<PullRequestComment>;
}

export interface BitbucketPage<A> {
  readonly items: ReadonlyArray<A>;
  /** The whole URL of the next page, which Bitbucket sends rather than an offset. */
  readonly next: string | null;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

/**
 * Bitbucket stamps times as `+00:00` with microseconds. The page sorts rows
 * from every host against each other as plain strings, so they are normalized
 * to the same `Z` form the other hosts already use.
 */
function toIsoUtc(value: string): string {
  return Option.match(DateTime.make(value), {
    onNone: () => value,
    onSome: DateTime.formatIso,
  });
}

/** An app account has no nickname, so its display name is the only handle it has. */
function toActor(
  raw: Schema.Schema.Type<typeof BitbucketUserSchema> | null | undefined,
): PullRequestActor | null {
  const login = trimmed(raw?.nickname) ?? trimmed(raw?.display_name);
  // Bitbucket names no bot flag on the accounts it hands back.
  return login === null ? null : { login, isBot: false };
}

function toState(raw: Schema.Schema.Type<typeof BitbucketPullRequestSchema>): PullRequestState {
  switch (raw.state?.trim().toUpperCase()) {
    case "MERGED":
      return "merged";
    case "DECLINED":
    case "SUPERSEDED":
      return "closed";
    default:
      return "open";
  }
}

function toBuildStatus(value: string | null | undefined): PullRequestCheckStatus {
  switch (value?.trim().toUpperCase()) {
    case "SUCCESSFUL":
      return "success";
    case "FAILED":
    case "STOPPED":
      return "failure";
    case "INPROGRESS":
      return "pending";
    default:
      return "skipped";
  }
}

function toReviewState(input: {
  readonly state?: string | null | undefined;
  readonly approved?: boolean | null | undefined;
}): PullRequestReviewState | null {
  switch (input.state?.trim().toLowerCase()) {
    case "approved":
      return "approved";
    case "changes_requested":
      return "changes-requested";
    default:
      return input.approved === true ? "approved" : null;
  }
}

/**
 * A participant who has voted is the closest Bitbucket has to a review, so it
 * reads as one in the conversation. Participants who were only added carry no
 * verdict and are skipped.
 */
function toReviews(
  raw: Schema.Schema.Type<typeof BitbucketPullRequestSchema>,
): ReadonlyArray<PullRequestComment> {
  return (raw.participants ?? []).flatMap((participant): ReadonlyArray<PullRequestComment> => {
    const author = toActor(participant.user);
    const votedAt = trimmed(participant.participated_on);
    const reviewState = toReviewState(participant);
    if (author === null || votedAt === null || reviewState === null) {
      return [];
    }
    return [
      {
        id: `${raw.id}:${author.login}`,
        kind: "review",
        author,
        // Bitbucket's verdict is a vote rather than a written review.
        body: "",
        createdAt: toIsoUtc(votedAt),
        url: null,
        reviewState,
        reactions: [],
        viewerIsAuthor: false,
      },
    ];
  });
}

function toRow(
  raw: Schema.Schema.Type<typeof BitbucketPullRequestSchema>,
): BitbucketPullRequestRow {
  const reviewers = (raw.reviewers ?? []).flatMap((reviewer) => {
    const actor = toActor(reviewer);
    const id = trimmed(reviewer.uuid);
    return actor === null || id === null ? [] : [{ id, login: actor.login }];
  });
  return {
    number: raw.id,
    title: raw.title,
    url: raw.links.html.href,
    author: toActor(raw.author),
    headBranch: raw.source.branch.name,
    baseBranch: raw.destination.branch.name,
    state: toState(raw),
    isDraft: raw.draft === true,
    createdAt: toIsoUtc(raw.created_on),
    updatedAt: toIsoUtc(raw.updated_on),
    body: raw.description ?? "",
    reviewRequestedLogins: reviewers.map((reviewer) => reviewer.login),
    reviewers,
    reviews: toReviews(raw),
  };
}

const decodePage = decodeJsonResult(BitbucketPageSchema);
const decodePullRequest = decodeJsonResult(BitbucketPullRequestSchema);
const decodePullRequestEntry = Schema.decodeUnknownExit(BitbucketPullRequestSchema);
const decodeCommentEntry = Schema.decodeUnknownExit(BitbucketCommentSchema);
const decodeCommitEntry = Schema.decodeUnknownExit(BitbucketCommitSchema);
const decodeStatusEntry = Schema.decodeUnknownExit(BitbucketStatusSchema);
const decodeDiffStatEntry = Schema.decodeUnknownExit(BitbucketDiffStatSchema);
const decodeMemberEntry = Schema.decodeUnknownExit(BitbucketMemberSchema);
const decodeViewer = decodeJsonResult(BitbucketViewerSchema);
const decodeRepositoryPermissions = decodeJsonResult(BitbucketRepositoryPermissionsSchema);
const decodeRepository = decodeJsonResult(BitbucketRepositorySchema);

/** Malformed entries are skipped rather than failing the page, as on the other hosts. */
export function decodeBitbucketPullRequestPageJson(
  raw: string,
): Result.Result<BitbucketPage<BitbucketPullRequestRow>, DecodeFailure> {
  const payload = decodePage(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  const items: BitbucketPullRequestRow[] = [];
  for (const entry of payload.success.values) {
    const decoded = decodePullRequestEntry(entry);
    if (Exit.isSuccess(decoded)) {
      items.push(toRow(decoded.value));
    }
  }
  return Result.succeed({ items, next: trimmed(payload.success.next) });
}

export function decodeBitbucketPullRequestJson(
  raw: string,
): Result.Result<BitbucketPullRequestRow, DecodeFailure> {
  const payload = decodePullRequest(raw);
  return Result.isSuccess(payload)
    ? Result.succeed(toRow(payload.success))
    : Result.fail(payload.failure);
}

export function decodeBitbucketViewerJson(
  raw: string,
): Result.Result<string | null, DecodeFailure> {
  const payload = decodeViewer(raw);
  return Result.isSuccess(payload)
    ? Result.succeed(trimmed(payload.success.nickname) ?? trimmed(payload.success.display_name))
    : Result.fail(payload.failure);
}

/**
 * Whether the configured credentials may write, which is what merging needs.
 * Bitbucket answers `admin`, `write` or `read`, and an empty page means it named
 * no permission at all for this account: an unknown standing, which is granted
 * rather than guessed away, leaving Bitbucket to refuse the merge and say why.
 */
export function decodeBitbucketRepositoryPermissionJson(
  raw: string,
): Result.Result<boolean, DecodeFailure> {
  const payload = decodeRepositoryPermissions(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  const permission = trimmed(payload.success.values?.[0]?.permission)?.toLowerCase() ?? null;
  return Result.succeed(permission === null || permission === "admin" || permission === "write");
}

export function decodeBitbucketRepositoryJson(
  raw: string,
): Result.Result<string | null, DecodeFailure> {
  const payload = decodeRepository(raw);
  return Result.isSuccess(payload)
    ? Result.succeed(trimmed(payload.success.mainbranch?.name))
    : Result.fail(payload.failure);
}

/** One comment as Bitbucket sent it, kept so threads can be assembled from them. */
export type BitbucketRawComment = Schema.Schema.Type<typeof BitbucketCommentSchema>;

export interface BitbucketComments {
  /** The conversation, which is every remark not pinned to a line. */
  readonly comments: ReadonlyArray<PullRequestComment>;
  /** The same comments unread, so the caller can assemble the line threads. */
  readonly entries: ReadonlyArray<BitbucketRawComment>;
  readonly next: string | null;
}

/**
 * Deleted comments and ones their author has not posted yet carry nothing to
 * show. A comment pinned to a file opens a line conversation, which the Code
 * tab reads from `buildBitbucketReviewThreads` rather than the Summary.
 */
export function decodeBitbucketCommentsJson(
  raw: string,
  viewer: string | null,
): Result.Result<BitbucketComments, DecodeFailure> {
  const payload = decodePage(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  const viewerLogin = viewer?.toLowerCase() ?? null;
  const comments: PullRequestComment[] = [];
  const kept: BitbucketRawComment[] = [];
  for (const entry of payload.success.values) {
    const decoded = decodeCommentEntry(entry);
    if (Exit.isFailure(decoded)) {
      continue;
    }
    const comment = decoded.value;
    const body = comment.content?.raw ?? "";
    if (comment.deleted === true || comment.pending === true || body.trim().length === 0) {
      continue;
    }
    kept.push(comment);
    if (trimmed(comment.inline?.path) !== null) {
      continue;
    }
    const author = toActor(comment.user);
    comments.push({
      id: String(comment.id),
      kind: "issue-comment",
      author,
      body,
      createdAt: toIsoUtc(comment.created_on),
      url: trimmed(comment.links?.html?.href),
      reviewState: null,
      // Bitbucket exposes no reaction on a pull request or on a comment.
      reactions: [],
      viewerIsAuthor: viewerLogin !== null && author?.login.toLowerCase() === viewerLogin,
    });
  }
  return Result.succeed({ comments, entries: kept, next: trimmed(payload.success.next) });
}

/**
 * Bitbucket returns one flat list, so a thread is reassembled from it: a comment
 * pinned to a line opens a thread, and every reply that leads back to it belongs
 * in it. A reply whose parent was never read has nowhere to go and is left out.
 */
export function buildBitbucketReviewThreads(
  comments: ReadonlyArray<BitbucketRawComment>,
  viewer: string | null,
): ReadonlyArray<PullRequestReviewThread> {
  const viewerLogin = viewer?.toLowerCase() ?? null;
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const rootOf = (comment: BitbucketRawComment) => {
    // Bounded by the number of comments read, so a parent cycle cannot spin.
    let current = comment;
    for (let step = 0; step < byId.size; step += 1) {
      const parentId = current.parent?.id;
      const parent = parentId === undefined ? undefined : byId.get(parentId);
      if (parent === undefined) {
        return current;
      }
      current = parent;
    }
    return current;
  };

  const threads = new Map<number, PullRequestReviewThread>();
  const replies = new Map<number, BitbucketRawComment[]>();
  for (const comment of comments) {
    const root = rootOf(comment);
    const inline = root.inline;
    const path = trimmed(inline?.path);
    if (path === null) {
      continue;
    }
    if (root.id === comment.id) {
      // `to` is the line as the file stands now, `from` the line it replaced; a
      // comment carrying only `from` was written against the removed side.
      const side = inline?.to == null ? "left" : "right";
      const line = side === "left" ? inline?.from : inline?.to;
      threads.set(root.id, {
        id: String(root.id),
        path,
        line: typeof line === "number" && line > 0 ? line : null,
        side,
        isResolved: root.resolution != null,
        isOutdated: inline?.outdated === true,
        comments: [],
      });
    }
    const bucket = replies.get(root.id);
    if (bucket === undefined) {
      replies.set(root.id, [comment]);
    } else {
      bucket.push(comment);
    }
  }

  return [...threads.values()].flatMap((thread) => {
    const entries = (replies.get(Number(thread.id)) ?? [])
      .toSorted((left, right) => left.created_on.localeCompare(right.created_on))
      .map((comment) => {
        const author = toActor(comment.user);
        return {
          id: String(comment.id),
          author,
          body: comment.content?.raw ?? "",
          createdAt: toIsoUtc(comment.created_on),
          url: trimmed(comment.links?.html?.href),
          reactions: [],
          viewerIsAuthor: viewerLogin !== null && author?.login.toLowerCase() === viewerLogin,
        };
      });
    return entries.length === 0 ? [] : [{ ...thread, comments: entries }];
  });
}

export function decodeBitbucketCommitsJson(
  raw: string,
): Result.Result<BitbucketPage<PullRequestCommit>, DecodeFailure> {
  const payload = decodePage(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  const commits: PullRequestCommit[] = [];
  for (const entry of payload.success.values) {
    const decoded = decodeCommitEntry(entry);
    if (Exit.isFailure(decoded)) {
      continue;
    }
    const commit = decoded.value;
    const committedDate = trimmed(commit.date);
    if (committedDate === null) {
      continue;
    }
    commits.push({
      oid: commit.hash,
      messageHeadline: (commit.message ?? "").split("\n")[0] ?? "",
      committedDate: toIsoUtc(committedDate),
      authorLogin: toActor(commit.author?.user)?.login ?? trimmed(commit.author?.raw),
    });
  }
  // Bitbucket lists a pull request's commits newest first; the timeline reads
  // oldest first.
  return Result.succeed({ items: commits.toReversed(), next: trimmed(payload.success.next) });
}

/**
 * Bitbucket re-uses a status key when a pipeline runs again, so the same check
 * can appear twice on one page. Nothing decoded says which copy is newer, so the
 * later one wins, which is the order Bitbucket writes an update in.
 */
export function decodeBitbucketStatusesJson(
  raw: string,
): Result.Result<BitbucketPage<PullRequestCheck>, DecodeFailure> {
  const payload = decodePage(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  const byName = new Map<string, PullRequestCheck>();
  for (const entry of payload.success.values) {
    const decoded = decodeStatusEntry(entry);
    if (Exit.isFailure(decoded)) {
      continue;
    }
    const status = decoded.value;
    const name = trimmed(status.name) ?? trimmed(status.key);
    if (name === null) {
      continue;
    }
    byName.set(trimmed(status.key) ?? name, {
      name,
      status: toBuildStatus(status.state),
      description: trimmed(status.description),
      url: trimmed(status.url),
    });
  }
  return Result.succeed({ items: [...byName.values()], next: trimmed(payload.success.next) });
}

export interface BitbucketDiffStat {
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly next: string | null;
}

/** One entry per changed file, each carrying that file's line counts. */
export function decodeBitbucketDiffStatJson(
  raw: string,
): Result.Result<BitbucketDiffStat, DecodeFailure> {
  const payload = decodePage(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;
  for (const entry of payload.success.values) {
    const decoded = decodeDiffStatEntry(entry);
    if (Exit.isFailure(decoded)) {
      continue;
    }
    additions += decoded.value.lines_added ?? 0;
    deletions += decoded.value.lines_removed ?? 0;
    changedFiles += 1;
  }
  return Result.succeed({
    additions,
    deletions,
    changedFiles,
    next: trimmed(payload.success.next),
  });
}

/**
 * The conflicts endpoint answers with one entry per conflicting path, so an
 * empty page is the only statement Bitbucket makes that a pull request merges
 * cleanly.
 */
export function decodeBitbucketConflictsJson(
  raw: string,
): Result.Result<PullRequestMergeability, DecodeFailure> {
  const payload = decodePage(raw);
  return Result.isSuccess(payload)
    ? Result.succeed(payload.success.values.length === 0 ? "mergeable" : "conflicting")
    : Result.fail(payload.failure);
}

/**
 * The workspace's members, which is the nearest thing Bitbucket has to "who may
 * review this": nothing on a repository lists the people with access to it, and
 * a pull request can be sent to anyone in the workspace.
 *
 * Nobody is marked requested here: who has been asked lives on the pull request,
 * and only the caller holds both.
 */
export function decodeBitbucketWorkspaceMembersJson(
  raw: string,
): Result.Result<BitbucketPage<PullRequestReviewerCandidate>, DecodeFailure> {
  const payload = decodePage(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  const items: PullRequestReviewerCandidate[] = [];
  for (const entry of payload.success.values) {
    const decoded = decodeMemberEntry(entry);
    if (Exit.isFailure(decoded)) {
      continue;
    }
    const uuid = trimmed(decoded.value.user?.uuid);
    const actor = toActor(decoded.value.user);
    if (uuid === null || actor === null) {
      continue;
    }
    items.push({
      id: uuid,
      kind: "user",
      login: actor.login,
      name: trimmed(decoded.value.user?.display_name),
      requested: false,
    });
  }
  return Result.succeed({ items, next: trimmed(payload.success.next) });
}

/** Bitbucket's merge strategies, named differently from the contract's three. */
export function bitbucketMergeStrategy(method: PullRequestMergeMethod | undefined): string {
  switch (method) {
    case "squash":
      return "squash";
    case "rebase":
      // The linear history GitHub calls "rebase and merge".
      return "rebase_fast_forward";
    default:
      return "merge_commit";
  }
}

function bitbucketPositionLine(position: PullRequestReviewPosition): {
  readonly from?: number;
  readonly to?: number;
} {
  switch (position.kind) {
    case "added":
      return { to: position.newLine };
    case "deleted":
      return { from: position.oldLine };
    case "context":
      return position.side === "left" ? { from: position.oldLine } : { to: position.newLine };
  }
}

const BitbucketCommentBodySchema = Schema.Struct({
  content: Schema.Struct({ raw: Schema.String }),
  parent: Schema.optionalKey(Schema.Struct({ id: Schema.Int })),
  inline: Schema.optionalKey(
    Schema.Struct({
      path: Schema.String,
      from: Schema.optionalKey(Schema.Int),
      to: Schema.optionalKey(Schema.Int),
    }),
  ),
});
const encodeCommentBody = Schema.encodeSync(Schema.fromJsonString(BitbucketCommentBodySchema));

/** A plain remark, which is also how a review summary is posted. */
export function buildBitbucketCommentJson(body: string): string {
  return encodeCommentBody({ content: { raw: body } });
}

/** A reply, which Bitbucket keeps in the same collection under a parent. */
export function buildBitbucketReplyJson(input: {
  readonly parentId: string;
  readonly body: string;
}): string {
  return encodeCommentBody({
    content: { raw: input.body },
    parent: { id: Number(input.parentId) },
  });
}

export function buildBitbucketInlineCommentJson(comment: PullRequestReviewCommentDraft): string {
  return encodeCommentBody({
    content: { raw: comment.body },
    inline: { path: comment.path, ...bitbucketPositionLine(comment.position) },
  });
}

const BitbucketPullRequestUpdateSchema = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
});
const encodePullRequestUpdate = Schema.encodeSync(
  Schema.fromJsonString(BitbucketPullRequestUpdateSchema),
);

/**
 * Only the words this call rewrites travel in the body: Bitbucket's PUT is a
 * partial update, so a field left out is left as it was.
 */
export function buildBitbucketPullRequestUpdateJson(input: {
  readonly title?: string;
  readonly body?: string;
}): string {
  return encodePullRequestUpdate({
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.body === undefined ? {} : { description: input.body }),
  });
}

const BitbucketMergeSchema = Schema.Struct({ merge_strategy: Schema.String });
const encodeMerge = Schema.encodeSync(Schema.fromJsonString(BitbucketMergeSchema));

export function buildBitbucketMergeJson(method: PullRequestMergeMethod | undefined): string {
  return encodeMerge({ merge_strategy: bitbucketMergeStrategy(method) });
}

const BitbucketReviewersSchema = Schema.Struct({
  reviewers: Schema.Array(Schema.Struct({ uuid: Schema.String })),
});
const encodeReviewers = Schema.encodeSync(Schema.fromJsonString(BitbucketReviewersSchema));

/**
 * Bitbucket has no endpoint that adds or removes one reviewer: the pull
 * request's `reviewers` is written whole, so the set already there is read first
 * and the change applied to it.
 */
export function buildBitbucketReviewersJson(input: {
  readonly current: ReadonlyArray<string>;
  readonly reviewers: ReadonlyArray<{ readonly id: string }>;
  readonly requested: boolean;
}): string {
  const uuids = new Set(input.current);
  for (const reviewer of input.reviewers) {
    if (input.requested) {
      uuids.add(reviewer.id);
    } else {
      uuids.delete(reviewer.id);
    }
  }
  return encodeReviewers({ reviewers: [...uuids].map((uuid) => ({ uuid })) });
}
