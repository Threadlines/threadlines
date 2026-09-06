import type * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  TrimmedNonEmptyString,
  type PullRequestActor,
  type PullRequestCheck,
  type PullRequestCheckStatus,
  type PullRequestChecksState,
  type PullRequestComment,
  type PullRequestCommit,
  type PullRequestLabel,
  type PullRequestMergeability,
  type PullRequestMergeMethod,
  type PullRequestReaction,
  type PullRequestReactionContent,
  type PullRequestReviewCommentDraft,
  type PullRequestReviewerCandidate,
  type PullRequestReviewPosition,
  type PullRequestReviewThread,
  type PullRequestState,
  type PullRequestThreadComment,
} from "@threadlines/contracts";
import { decodeJsonResult } from "@threadlines/shared/schemaJson";

import type { ProviderRepositoryAccess } from "./PullRequestProvider.ts";

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

/**
 * GitLab's REST enums are decoded as plain strings and normalized here: a
 * GitLab release that adds a pipeline status or a merge status must not fail
 * the whole payload.
 */
const GitLabUserSchema = Schema.Struct({
  /**
   * GitLab writes a merge request's reviewers as numeric ids and takes no
   * usernames there, so the id travels beside the handle rather than being
   * looked up again when a review is asked for.
   */
  id: Schema.optional(Schema.NullOr(Schema.Int)),
  username: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitLabPipelineSchema = Schema.Struct({
  status: Schema.optional(Schema.NullOr(Schema.String)),
  web_url: Schema.optional(Schema.NullOr(Schema.String)),
  source: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitLabMergeRequestSchema = Schema.Struct({
  iid: Schema.Int,
  title: TrimmedNonEmptyString,
  web_url: TrimmedNonEmptyString,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(GitLabUserSchema)),
  source_branch: TrimmedNonEmptyString,
  target_branch: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  work_in_progress: Schema.optional(Schema.NullOr(Schema.Boolean)),
  merge_status: Schema.optional(Schema.NullOr(Schema.String)),
  has_conflicts: Schema.optional(Schema.NullOr(Schema.Boolean)),
  created_at: TrimmedNonEmptyString,
  updated_at: TrimmedNonEmptyString,
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(GitLabUserSchema))),
  labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  /** A string, and "1000+" past GitLab's counting limit, so it is parsed rather than decoded. */
  changes_count: Schema.optional(Schema.NullOr(Schema.String)),
  head_pipeline: Schema.optional(Schema.NullOr(GitLabPipelineSchema)),
  /**
   * Whether GitLab is holding the merge until the pipeline passes.
   * `merge_when_pipeline_succeeds` is the field every version answers with;
   * newer ones also carry `auto_merge_enabled`, which is the same fact under
   * the name GitLab settled on, so either one saying yes is a yes.
   */
  merge_when_pipeline_succeeds: Schema.optional(Schema.NullOr(Schema.Boolean)),
  auto_merge_enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /**
   * How far the target branch has moved on since this one left it. It costs a
   * walk of both branches, so GitLab withholds it unless
   * `include_diverged_commits_count` asks, and answers it for one merge
   * request only.
   */
  diverged_commits_count: Schema.optional(Schema.NullOr(Schema.Int)),
  diff_refs: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        base_sha: Schema.optional(Schema.NullOr(Schema.String)),
        head_sha: Schema.optional(Schema.NullOr(Schema.String)),
        start_sha: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const GitLabNoteSchema = Schema.Struct({
  id: Schema.Int,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(GitLabUserSchema)),
  created_at: TrimmedNonEmptyString,
  /** True for notes GitLab writes itself ("assigned to…"), which are events, not remarks. */
  system: Schema.optional(Schema.NullOr(Schema.Boolean)),
  type: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * A note inside a discussion, carrying its place in the diff. `resolved` lives
 * on the note rather than on the discussion: GitLab calls a discussion resolved
 * once its resolvable notes are.
 */
const GitLabDiscussionNoteSchema = Schema.Struct({
  ...GitLabNoteSchema.fields,
  resolvable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  resolved: Schema.optional(Schema.NullOr(Schema.Boolean)),
  position: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        position_type: Schema.optional(Schema.NullOr(Schema.String)),
        new_path: Schema.optional(Schema.NullOr(Schema.String)),
        old_path: Schema.optional(Schema.NullOr(Schema.String)),
        new_line: Schema.optional(Schema.NullOr(Schema.Int)),
        old_line: Schema.optional(Schema.NullOr(Schema.Int)),
      }),
    ),
  ),
});

const GitLabDiscussionSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  notes: Schema.optional(Schema.NullOr(Schema.Array(GitLabDiscussionNoteSchema))),
});

const GitLabCommitSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  committed_date: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  author_name: Schema.optional(Schema.NullOr(Schema.String)),
  author_email: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitLabDiffSchema = Schema.Struct({
  old_path: Schema.String,
  new_path: Schema.String,
  a_mode: Schema.optional(Schema.NullOr(Schema.String)),
  b_mode: Schema.optional(Schema.NullOr(Schema.String)),
  new_file: Schema.optional(Schema.NullOr(Schema.Boolean)),
  renamed_file: Schema.optional(Schema.NullOr(Schema.Boolean)),
  deleted_file: Schema.optional(Schema.NullOr(Schema.Boolean)),
  diff: Schema.optional(Schema.NullOr(Schema.String)),
  /** GitLab withholds the hunks for a file it considers too large, or collapsed. */
  too_large: Schema.optional(Schema.NullOr(Schema.Boolean)),
  collapsed: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const GitLabViewerSchema = Schema.Struct({
  username: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitLabApprovalsSchema = Schema.Struct({
  approved_by: Schema.optional(
    Schema.NullOr(
      Schema.Array(Schema.Struct({ user: Schema.optional(Schema.NullOr(GitLabUserSchema)) })),
    ),
  ),
});

/**
 * A GitLab project settles on one merge strategy plus an optional squash, and
 * states the reader's own role on it.
 */
const GitLabProjectSchema = Schema.Struct({
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
  merge_method: Schema.optional(Schema.NullOr(Schema.String)),
  squash_option: Schema.optional(Schema.NullOr(Schema.String)),
  permissions: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        project_access: Schema.optional(
          Schema.NullOr(
            Schema.Struct({ access_level: Schema.optional(Schema.NullOr(Schema.Int)) }),
          ),
        ),
        group_access: Schema.optional(
          Schema.NullOr(
            Schema.Struct({ access_level: Schema.optional(Schema.NullOr(Schema.Int)) }),
          ),
        ),
      }),
    ),
  ),
});

/** One decoded merge request row, before the service attaches its project. */
export interface GitLabMergeRequestRow {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  /** `unknown` while GitLab is still checking, which every listing may see. */
  readonly mergeability: PullRequestMergeability;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewRequestedLogins: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  readonly checksState?: PullRequestChecksState;
  /** Absent where GitLab named neither auto-merge field, which is not "off". */
  readonly autoMergeEnabled?: boolean;
}

/** The three revisions a positioned comment is written against. */
export interface GitLabDiffRefs {
  readonly baseSha: string;
  readonly headSha: string;
  readonly startSha: string;
}

export interface GitLabMergeRequestDetailRow extends GitLabMergeRequestRow {
  readonly body: string;
  readonly changedFiles: number;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  /** Requested reviewers, keyed by the numeric id a reviewer write takes. */
  readonly reviewers: ReadonlyArray<{
    readonly id: string;
    readonly login: string;
    readonly avatarUrl: string | null;
  }>;
  readonly checks: ReadonlyArray<PullRequestCheck>;
  /** Null where GitLab did not count, which is not the same as "up to date". */
  readonly behindBy: number | null;
  /** Null on a merge request with no revisions to place a comment against. */
  readonly diffRefs: GitLabDiffRefs | null;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

/** GitLab names no bot flag on the accounts it hands back with a merge request. */
function toActor(
  raw: Schema.Schema.Type<typeof GitLabUserSchema> | null | undefined,
): PullRequestActor | null {
  const login = trimmed(raw?.username);
  return login === null ? null : { login, isBot: false, avatarUrl: trimmed(raw?.avatar_url) };
}

function toState(raw: Schema.Schema.Type<typeof GitLabMergeRequestSchema>): PullRequestState {
  if (trimmed(raw.merged_at) !== null) {
    return "merged";
  }
  switch (raw.state?.trim().toLowerCase()) {
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    default:
      // `locked` is an open merge request whose discussion is locked.
      return "open";
  }
}

function toMergeability(
  raw: Schema.Schema.Type<typeof GitLabMergeRequestSchema>,
): PullRequestMergeability {
  if (raw.has_conflicts === true) {
    return "conflicting";
  }
  switch (raw.merge_status?.trim().toLowerCase()) {
    case "can_be_merged":
      return "mergeable";
    case "cannot_be_merged":
      return "conflicting";
    default:
      // `unchecked` and `checking` mean GitLab has not finished the check.
      return "unknown";
  }
}

/** GitLab reports label names only, so there is no colour to carry. */
function toLabels(raw: ReadonlyArray<string> | null | undefined): ReadonlyArray<PullRequestLabel> {
  return (raw ?? []).flatMap((label) => {
    const name = trimmed(label);
    return name === null ? [] : [{ name, color: null }];
  });
}

/**
 * "3" for a counted change set, "1000+" once GitLab gives up counting. The
 * leading number is the floor either way, which reads better than dropping an
 * uncounted change set to nothing.
 */
function toChangedFiles(value: string | null | undefined): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function toPipelineStatus(value: string | null | undefined): PullRequestCheckStatus {
  switch (value?.trim().toLowerCase()) {
    case "success":
      return "success";
    case "failed":
    case "canceled":
    case "cancelling":
      return "failure";
    // A pipeline waiting on a person has not run and is nobody's problem.
    case "skipped":
    case "manual":
    case "scheduled":
      return "skipped";
    default:
      return "pending";
  }
}

/**
 * GitLab has no per-job check list on a merge request, so its head pipeline is
 * the one check. The jobs behind it stay one click away through its URL.
 */
function toChecks(
  raw: Schema.Schema.Type<typeof GitLabMergeRequestSchema>,
): ReadonlyArray<PullRequestCheck> {
  const pipeline = raw.head_pipeline;
  if (!pipeline) {
    return [];
  }
  return [
    {
      name: "Pipeline",
      status: toPipelineStatus(pipeline.status),
      description: trimmed(pipeline.source),
      url: trimmed(pipeline.web_url),
    },
  ];
}

function toChecksState(
  raw: Schema.Schema.Type<typeof GitLabMergeRequestSchema>,
): PullRequestChecksState | undefined {
  if (!raw.head_pipeline) {
    return undefined;
  }
  switch (toPipelineStatus(raw.head_pipeline.status)) {
    case "failure":
      return "failure";
    case "pending":
      return "pending";
    default:
      return "success";
  }
}

function toRow(raw: Schema.Schema.Type<typeof GitLabMergeRequestSchema>): GitLabMergeRequestRow {
  const checksState = toChecksState(raw);
  const autoMergeEnabled =
    raw.merge_when_pipeline_succeeds == null && raw.auto_merge_enabled == null
      ? undefined
      : raw.merge_when_pipeline_succeeds === true || raw.auto_merge_enabled === true;
  return {
    number: raw.iid,
    title: raw.title,
    url: raw.web_url,
    author: toActor(raw.author),
    headBranch: raw.source_branch,
    baseBranch: raw.target_branch,
    state: toState(raw),
    isDraft: raw.draft === true || raw.work_in_progress === true,
    mergeability: toMergeability(raw),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    reviewRequestedLogins: (raw.reviewers ?? []).flatMap((reviewer) => {
      const login = trimmed(reviewer.username);
      return login === null ? [] : [login];
    }),
    labels: toLabels(raw.labels),
    ...(checksState === undefined ? {} : { checksState }),
    ...(autoMergeEnabled === undefined ? {} : { autoMergeEnabled }),
  };
}

function toDiffRefs(
  raw: Schema.Schema.Type<typeof GitLabMergeRequestSchema>,
): GitLabDiffRefs | null {
  const baseSha = trimmed(raw.diff_refs?.base_sha);
  const headSha = trimmed(raw.diff_refs?.head_sha);
  const startSha = trimmed(raw.diff_refs?.start_sha);
  return baseSha === null || headSha === null || startSha === null
    ? null
    : { baseSha, headSha, startSha };
}

function toDetailRow(
  raw: Schema.Schema.Type<typeof GitLabMergeRequestSchema>,
): GitLabMergeRequestDetailRow {
  return {
    ...toRow(raw),
    body: raw.description ?? "",
    changedFiles: toChangedFiles(raw.changes_count),
    mergedAt: trimmed(raw.merged_at),
    closedAt: trimmed(raw.closed_at),
    reviewers: (raw.reviewers ?? []).flatMap((reviewer) => {
      const actor = toActor(reviewer);
      return actor === null || reviewer.id == null
        ? []
        : [{ id: String(reviewer.id), login: actor.login, avatarUrl: actor.avatarUrl }];
    }),
    checks: toChecks(raw),
    behindBy: raw.diverged_commits_count ?? null,
    diffRefs: toDiffRefs(raw),
  };
}

const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeMergeRequestEntry = Schema.decodeUnknownExit(GitLabMergeRequestSchema);
const decodeMergeRequest = decodeJsonResult(GitLabMergeRequestSchema);
const decodeNoteEntry = Schema.decodeUnknownExit(GitLabNoteSchema);
const decodeDiscussionEntry = Schema.decodeUnknownExit(GitLabDiscussionSchema);
const decodeCommitEntry = Schema.decodeUnknownExit(GitLabCommitSchema);
const decodeDiffEntry = Schema.decodeUnknownExit(GitLabDiffSchema);
const decodeUserEntry = Schema.decodeUnknownExit(GitLabUserSchema);
const decodeViewer = decodeJsonResult(GitLabViewerSchema);
const decodeApprovals = decodeJsonResult(GitLabApprovalsSchema);
const decodeProject = decodeJsonResult(GitLabProjectSchema);

/**
 * Malformed rows are skipped rather than failing the batch: one unexpected
 * merge request must not blank the whole list.
 */
export function decodeGitLabMergeRequestListJson(
  raw: string,
): Result.Result<ReadonlyArray<GitLabMergeRequestRow>, DecodeFailure> {
  const payload = decodeUnknownList(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  const rows: GitLabMergeRequestRow[] = [];
  for (const entry of payload.success) {
    const decoded = decodeMergeRequestEntry(entry);
    if (Exit.isSuccess(decoded)) {
      rows.push(toRow(decoded.value));
    }
  }
  return Result.succeed(rows);
}

export function decodeGitLabMergeRequestDetailJson(
  raw: string,
): Result.Result<GitLabMergeRequestDetailRow, DecodeFailure> {
  const payload = decodeMergeRequest(raw);
  return Result.isSuccess(payload)
    ? Result.succeed(toDetailRow(payload.success))
    : Result.fail(payload.failure);
}

export function decodeGitLabViewerJson(raw: string): Result.Result<string | null, DecodeFailure> {
  const payload = decodeViewer(raw);
  return Result.isSuccess(payload)
    ? Result.succeed(trimmed(payload.success.username))
    : Result.fail(payload.failure);
}

/** Who has approved, which is the only verdict GitLab records per reviewer. */
export function decodeGitLabApprovalsJson(
  raw: string,
): Result.Result<ReadonlyArray<string>, DecodeFailure> {
  const payload = decodeApprovals(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  return Result.succeed(
    (payload.success.approved_by ?? []).flatMap((approval) => {
      const login = trimmed(approval.user?.username);
      return login === null ? [] : [login];
    }),
  );
}

/** The Developer role, which is the lowest one GitLab lets merge. */
const GITLAB_DEVELOPER_ACCESS_LEVEL = 30;

/** The order the detail surface offers the allowed merge methods in. */
const MERGE_METHOD_ORDER = [
  "merge",
  "squash",
  "rebase",
] as const satisfies ReadonlyArray<PullRequestMergeMethod>;

/**
 * The project's own settings. GitLab settles the strategy per project rather
 * than offering all three per merge request: `merge_method` picks a merge
 * commit, a semi-linear history or fast-forward, and squashing is a switch of
 * its own. A project that names no strategy at all is not forbidding one, so
 * all three are offered and GitLab refuses what it does not allow.
 */
export function decodeGitLabProjectJson(
  raw: string,
): Result.Result<ProviderRepositoryAccess, DecodeFailure> {
  const payload = decodeProject(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  const row = payload.success;
  const mergeMethod = trimmed(row.merge_method)?.toLowerCase() ?? null;
  const squashOption = trimmed(row.squash_option)?.toLowerCase() ?? null;
  const accessLevel = Math.max(
    row.permissions?.project_access?.access_level ?? 0,
    row.permissions?.group_access?.access_level ?? 0,
  );
  const allowed = new Set<PullRequestMergeMethod>();
  if (mergeMethod === "merge") {
    allowed.add("merge");
  }
  // Both a semi-linear and a fast-forward history are reached by rebasing.
  if (mergeMethod === "rebase_merge" || mergeMethod === "ff") {
    allowed.add("rebase");
  }
  if (
    squashOption === "always" ||
    squashOption === "default_on" ||
    squashOption === "default_off"
  ) {
    allowed.add("squash");
  }

  return Result.succeed({
    canWrite: accessLevel >= GITLAB_DEVELOPER_ACCESS_LEVEL,
    mergeMethods:
      mergeMethod === null && allowed.size === 0
        ? MERGE_METHOD_ORDER
        : MERGE_METHOD_ORDER.filter((method) => allowed.has(method)),
    defaultBranch: trimmed(row.default_branch),
  });
}

/**
 * The conversation. System notes are GitLab's own activity entries, and a
 * `DiffNote` opens a line discussion, which the Code tab reads separately.
 */
export function decodeGitLabNotesJson(
  raw: string,
  viewer: string | null,
): Result.Result<ReadonlyArray<PullRequestComment>, DecodeFailure> {
  const payload = decodeUnknownList(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  const viewerLogin = viewer?.toLowerCase() ?? null;
  const comments: PullRequestComment[] = [];
  for (const entry of payload.success) {
    const decoded = decodeNoteEntry(entry);
    if (Exit.isFailure(decoded)) {
      continue;
    }
    const note = decoded.value;
    const body = note.body ?? "";
    if (note.system === true || body.trim().length === 0) {
      continue;
    }
    if (trimmed(note.type) === "DiffNote") {
      continue;
    }
    const author = toActor(note.author);
    comments.push({
      id: String(note.id),
      kind: "issue-comment",
      author,
      body,
      createdAt: note.created_at,
      // GitLab does not link a note on its own; the merge request page carries it.
      url: null,
      reviewState: null,
      reactions: [],
      viewerIsAuthor: viewerLogin !== null && author?.login.toLowerCase() === viewerLogin,
    });
  }
  // ISO timestamps sort lexicographically; the conversation reads oldest first.
  return Result.succeed(
    comments.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
  );
}

/**
 * Positioned discussions only. GitLab returns the whole conversation here,
 * including the plain notes the Summary already shows, and only a positioned
 * one belongs against a line of the diff.
 */
export function decodeGitLabDiscussionsJson(
  raw: string,
  viewer: string | null,
): Result.Result<ReadonlyArray<PullRequestReviewThread>, DecodeFailure> {
  const payload = decodeUnknownList(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  const viewerLogin = viewer?.toLowerCase() ?? null;
  const threads: PullRequestReviewThread[] = [];
  for (const entry of payload.success) {
    const decoded = decodeDiscussionEntry(entry);
    if (Exit.isFailure(decoded)) {
      continue;
    }
    const notes = (decoded.value.notes ?? []).filter((note) => note.system !== true);
    const root = notes[0];
    const position = root?.position;
    if (root === undefined || !position || trimmed(position.position_type) !== "text") {
      continue;
    }
    // A comment on an added or context line carries `new_line`; one on a
    // removed line carries only `old_line`, and belongs against the old file.
    const side = position.new_line == null ? "left" : "right";
    const path = trimmed(side === "left" ? position.old_path : position.new_path);
    const line = side === "left" ? position.old_line : position.new_line;
    if (path === null) {
      continue;
    }
    threads.push({
      id: decoded.value.id,
      path,
      line: typeof line === "number" && line > 0 ? line : null,
      side,
      isResolved: root.resolved === true,
      // GitLab reports nothing equivalent to "written against a line that has
      // since moved", so a thread the diff cannot place is worked out there.
      isOutdated: false,
      comments: notes.map((note): PullRequestThreadComment => {
        const author = toActor(note.author);
        return {
          id: String(note.id),
          author,
          body: note.body ?? "",
          createdAt: note.created_at,
          url: null,
          reactions: [],
          viewerIsAuthor: viewerLogin !== null && author?.login.toLowerCase() === viewerLogin,
        };
      }),
    });
  }
  return Result.succeed(threads);
}

export function decodeGitLabCommitsJson(
  raw: string,
): Result.Result<ReadonlyArray<PullRequestCommit>, DecodeFailure> {
  const payload = decodeUnknownList(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  const commits: PullRequestCommit[] = [];
  for (const entry of payload.success) {
    const decoded = decodeCommitEntry(entry);
    if (Exit.isFailure(decoded)) {
      continue;
    }
    const commit = decoded.value;
    const committedDate = trimmed(commit.committed_date) ?? trimmed(commit.created_at);
    if (committedDate === null) {
      continue;
    }
    commits.push({
      oid: commit.id,
      messageHeadline: commit.title ?? "",
      committedDate,
      // GitLab records the git author, not the account, so the name stands in.
      authorLogin: trimmed(commit.author_name) ?? trimmed(commit.author_email),
    });
  }
  // GitLab lists a merge request's commits newest first; the timeline reads
  // oldest first.
  return Result.succeed(commits.toReversed());
}

export interface GitLabMergeRequestPatch {
  readonly patch: string;
  /** At least one file's hunks were withheld by GitLab as too large to inline. */
  readonly truncated: boolean;
  /** Files GitLab returned, counted before decoding, so the caller can page. */
  readonly rawCount: number;
}

function diffHeaderPaths(raw: Schema.Schema.Type<typeof GitLabDiffSchema>): {
  readonly from: string;
  readonly to: string;
} {
  return {
    from: raw.new_file === true ? "/dev/null" : `a/${raw.old_path}`,
    to: raw.deleted_file === true ? "/dev/null" : `b/${raw.new_path}`,
  };
}

/**
 * GitLab returns hunks per file with no `diff --git` header, so the unified
 * patch every diff viewer expects is assembled here.
 */
export function decodeGitLabDiffsJson(
  raw: string,
): Result.Result<GitLabMergeRequestPatch, DecodeFailure> {
  const payload = decodeUnknownList(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  const sections: string[] = [];
  let truncated = false;
  for (const entry of payload.success) {
    const decoded = decodeDiffEntry(entry);
    if (Exit.isFailure(decoded)) {
      continue;
    }
    const file = decoded.value;
    const hunks = file.diff ?? "";
    if (hunks.length === 0) {
      // A file GitLab declined to inline still belongs in the list, header only.
      truncated = truncated || file.too_large === true || file.collapsed === true;
    }
    const { from, to } = diffHeaderPaths(file);
    const header = [
      `diff --git a/${file.old_path} b/${file.new_path}`,
      ...(file.new_file === true ? [`new file mode ${file.b_mode ?? "100644"}`] : []),
      ...(file.deleted_file === true ? [`deleted file mode ${file.a_mode ?? "100644"}`] : []),
      ...(file.renamed_file === true
        ? [`rename from ${file.old_path}`, `rename to ${file.new_path}`]
        : []),
      `--- ${from}`,
      `+++ ${to}`,
    ].join("\n");
    sections.push(hunks.length === 0 ? header : `${header}\n${hunks.replace(/\n?$/, "\n")}`);
  }
  return Result.succeed({
    patch: sections.length === 0 ? "" : `${sections.join("\n").replace(/\n?$/, "\n")}`,
    truncated,
    rawCount: payload.success.length,
  });
}

export interface GitLabReviewerCandidates {
  readonly candidates: ReadonlyArray<PullRequestReviewerCandidate>;
  /** Rows GitLab returned, counted before decoding, so a skipped row still counts. */
  readonly rawCount: number;
}

/**
 * The people with access to the project, which is the list GitLab fills its own
 * reviewer field from. Nobody is marked requested here: who has been asked
 * lives on the merge request, and only the caller holds both.
 */
export function decodeGitLabProjectUsersJson(
  raw: string,
): Result.Result<GitLabReviewerCandidates, DecodeFailure> {
  const payload = decodeUnknownList(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  const candidates: PullRequestReviewerCandidate[] = [];
  for (const entry of payload.success) {
    const decoded = decodeUserEntry(entry);
    if (Exit.isFailure(decoded) || decoded.value.id == null) {
      continue;
    }
    const login = trimmed(decoded.value.username);
    if (login === null) {
      continue;
    }
    candidates.push({
      id: String(decoded.value.id),
      kind: "user",
      login,
      name: trimmed(decoded.value.name),
      avatarUrl: trimmed(decoded.value.avatar_url),
      requested: false,
    });
  }
  return Result.succeed({ candidates, rawCount: payload.success.length });
}

/** GitLab's award names for the eight reactions the contract carries. */
const GITLAB_AWARD_BY_CONTENT: Readonly<Record<PullRequestReactionContent, string>> = {
  "thumbs-up": "thumbsup",
  "thumbs-down": "thumbsdown",
  laugh: "laughing",
  hooray: "tada",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};

const CONTENT_BY_GITLAB_AWARD: Readonly<Record<string, PullRequestReactionContent>> =
  Object.fromEntries(
    Object.entries(GITLAB_AWARD_BY_CONTENT).map(([content, name]) => [name, content]),
  ) as Readonly<Record<string, PullRequestReactionContent>>;

export function gitLabAwardName(content: PullRequestReactionContent): string {
  return GITLAB_AWARD_BY_CONTENT[content];
}

/**
 * Awards on the merge request and on every note of it, in one read. The REST
 * notes endpoint the conversation comes from carries no award at all, and
 * asking per note would be a request each.
 */
export const GITLAB_AWARD_EMOJI_GRAPHQL_QUERY = `query($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {
      awardEmoji { nodes { name user { username } } }
      notes(first: 100) { nodes { id awardEmoji { nodes { name user { username } } } } }
    }
  }
}`;

const GitLabAwardNodesSchema = Schema.optional(
  Schema.NullOr(
    Schema.Struct({
      nodes: Schema.optional(
        Schema.NullOr(
          Schema.Array(
            Schema.NullOr(
              Schema.Struct({
                name: Schema.optional(Schema.NullOr(Schema.String)),
                user: Schema.optional(Schema.NullOr(GitLabUserSchema)),
              }),
            ),
          ),
        ),
      ),
    }),
  ),
);

const GitLabAwardPageSchema = Schema.Struct({
  data: Schema.Struct({
    project: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          mergeRequest: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                awardEmoji: GitLabAwardNodesSchema,
                notes: Schema.optional(
                  Schema.NullOr(
                    Schema.Struct({
                      nodes: Schema.optional(
                        Schema.NullOr(
                          Schema.Array(
                            Schema.NullOr(
                              Schema.Struct({
                                id: Schema.optional(Schema.NullOr(Schema.String)),
                                awardEmoji: GitLabAwardNodesSchema,
                              }),
                            ),
                          ),
                        ),
                      ),
                    }),
                  ),
                ),
              }),
            ),
          ),
        }),
      ),
    ),
  }),
});

const decodeAwardPage = decodeJsonResult(GitLabAwardPageSchema);

/**
 * The awards on one subject, grouped the way a reaction chip is drawn. An award
 * outside the eight the contract carries is left out rather than shown under a
 * name the picker has no way to take back.
 */
function toReactions(
  nodes: Schema.Schema.Type<typeof GitLabAwardNodesSchema>,
  viewer: string | null,
): ReadonlyArray<PullRequestReaction> {
  const viewerLogin = viewer?.toLowerCase() ?? null;
  const groups = new Map<PullRequestReactionContent, { count: number; viewerReacted: boolean }>();
  for (const node of nodes?.nodes ?? []) {
    const content = CONTENT_BY_GITLAB_AWARD[trimmed(node?.name)?.toLowerCase() ?? ""];
    if (content === undefined) {
      continue;
    }
    const group = groups.get(content) ?? { count: 0, viewerReacted: false };
    group.count += 1;
    if (viewerLogin !== null && trimmed(node?.user?.username)?.toLowerCase() === viewerLogin) {
      group.viewerReacted = true;
    }
    groups.set(content, group);
  }
  return [...groups].map(([content, group]) => ({
    content,
    count: group.count,
    viewerReacted: group.viewerReacted,
  }));
}

/** `gid://gitlab/DiffNote/42` is note 42, which is the id the REST notes carry. */
function noteIdOf(gid: string | null | undefined): string | null {
  const id = trimmed(gid)?.split("/").at(-1);
  return id !== undefined && /^\d+$/.test(id) ? id : null;
}

export interface GitLabAwards {
  /** The merge request's own awards, which are the ones on its description. */
  readonly reactions: ReadonlyArray<PullRequestReaction>;
  readonly reactionsByNoteId: ReadonlyMap<string, ReadonlyArray<PullRequestReaction>>;
}

export function decodeGitLabAwardsJson(
  raw: string,
  viewer: string | null,
): Result.Result<GitLabAwards, DecodeFailure> {
  const payload = decodeAwardPage(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  const mergeRequest = payload.success.data.project?.mergeRequest;
  const reactionsByNoteId = new Map<string, ReadonlyArray<PullRequestReaction>>();
  for (const node of mergeRequest?.notes?.nodes ?? []) {
    const id = noteIdOf(node?.id);
    if (id === null) {
      continue;
    }
    const reactions = toReactions(node?.awardEmoji, viewer);
    if (reactions.length > 0) {
      reactionsByNoteId.set(id, reactions);
    }
  }
  return Result.succeed({
    reactions: toReactions(mergeRequest?.awardEmoji, viewer),
    reactionsByNoteId,
  });
}

const GitLabAwardSchema = Schema.Struct({
  id: Schema.Int,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(GitLabUserSchema)),
});

const decodeAwardEntry = Schema.decodeUnknownExit(GitLabAwardSchema);

/**
 * The reader's own award of one name on a subject, which is how a reaction is
 * taken back: GitLab deletes an award by its id and cannot name one by emoji.
 */
export function decodeGitLabOwnAwardIdJson(
  raw: string,
  input: { readonly content: PullRequestReactionContent; readonly viewer: string },
): Result.Result<number | null, DecodeFailure> {
  const payload = decodeUnknownList(raw);
  if (!Result.isSuccess(payload)) {
    return Result.fail(payload.failure);
  }
  const name = gitLabAwardName(input.content);
  const viewerLogin = input.viewer.toLowerCase();
  for (const entry of payload.success) {
    const decoded = decodeAwardEntry(entry);
    if (Exit.isFailure(decoded)) {
      continue;
    }
    if (trimmed(decoded.value.name)?.toLowerCase() !== name) {
      continue;
    }
    if (trimmed(decoded.value.user?.username)?.toLowerCase() !== viewerLogin) {
      continue;
    }
    return Result.succeed(decoded.value.id);
  }
  return Result.succeed(null);
}

/**
 * Where a line comment hangs, as GitLab's position object names it. A line the
 * change added exists only in the new file, one it deleted only in the old, and
 * a context line in both.
 */
function gitLabPositionLines(position: PullRequestReviewPosition): {
  readonly old_line?: number;
  readonly new_line?: number;
} {
  switch (position.kind) {
    case "added":
      return { new_line: position.newLine };
    case "deleted":
      return { old_line: position.oldLine };
    case "context":
      return { old_line: position.oldLine, new_line: position.newLine };
  }
}

const GitLabNoteBodySchema = Schema.Struct({ body: Schema.String });
const encodeNoteBody = Schema.encodeSync(Schema.fromJsonString(GitLabNoteBodySchema));

/** The body of a plain note, a reply, and a review summary. */
export function buildGitLabNoteBodyJson(body: string): string {
  return encodeNoteBody({ body });
}

const GitLabResolutionSchema = Schema.Struct({ resolved: Schema.Boolean });
const encodeResolution = Schema.encodeSync(Schema.fromJsonString(GitLabResolutionSchema));

export function buildGitLabResolutionJson(resolved: boolean): string {
  return encodeResolution({ resolved });
}

const GitLabMergeRequestUpdateSchema = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
});
const encodeMergeRequestUpdate = Schema.encodeSync(
  Schema.fromJsonString(GitLabMergeRequestUpdateSchema),
);

/**
 * Only the fields the caller asked to change: GitLab leaves out what it is not
 * sent, and clears what it is sent empty, so a title corrected on its own must
 * carry no description at all.
 */
export function buildGitLabMergeRequestUpdateJson(input: {
  readonly title?: string;
  readonly body?: string;
}): string {
  return encodeMergeRequestUpdate({
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.body === undefined ? {} : { description: input.body }),
  });
}

const GitLabReviewerIdsSchema = Schema.Struct({ reviewer_ids: Schema.Array(Schema.Int) });
const encodeReviewerIds = Schema.encodeSync(Schema.fromJsonString(GitLabReviewerIdsSchema));

/**
 * GitLab has no endpoint that adds or removes one reviewer: `reviewer_ids`
 * replaces the whole set, so the set already there is read first and the change
 * applied to it. An id GitLab never named is dropped rather than written, so a
 * stale client cannot rewrite the set around a number nobody chose.
 */
export function buildGitLabReviewerIdsJson(input: {
  readonly current: ReadonlyArray<string>;
  readonly reviewers: ReadonlyArray<{ readonly id: string }>;
  readonly requested: boolean;
}): string {
  const ids = new Set<number>();
  for (const id of input.current) {
    const parsed = Number(id);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      ids.add(parsed);
    }
  }
  for (const reviewer of input.reviewers) {
    const parsed = Number(reviewer.id);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      continue;
    }
    if (input.requested) {
      ids.add(parsed);
    } else {
      ids.delete(parsed);
    }
  }
  return encodeReviewerIds({ reviewer_ids: [...ids] });
}

const GitLabDiscussionPositionSchema = Schema.Struct({
  body: Schema.String,
  position: Schema.Struct({
    base_sha: Schema.String,
    head_sha: Schema.String,
    start_sha: Schema.String,
    position_type: Schema.Literal("text"),
    old_path: Schema.String,
    new_path: Schema.String,
    old_line: Schema.optionalKey(Schema.Int),
    new_line: Schema.optionalKey(Schema.Int),
  }),
});
const encodeDiscussionPosition = Schema.encodeSync(
  Schema.fromJsonString(GitLabDiscussionPositionSchema),
);

/**
 * One line comment as a positioned discussion. Both paths travel because GitLab
 * resolves a position against both sides of the diff; they differ only for a
 * renamed file, which is why the draft carries the name it had before.
 */
export function buildGitLabDiscussionJson(input: {
  readonly comment: PullRequestReviewCommentDraft;
  readonly refs: GitLabDiffRefs;
}): string {
  return encodeDiscussionPosition({
    body: input.comment.body,
    position: {
      base_sha: input.refs.baseSha,
      head_sha: input.refs.headSha,
      start_sha: input.refs.startSha,
      position_type: "text",
      old_path: input.comment.oldPath ?? input.comment.path,
      new_path: input.comment.path,
      ...gitLabPositionLines(input.comment.position),
    },
  });
}

const GitLabGraphQlRequestSchema = Schema.Struct({
  query: Schema.String,
  variables: Schema.Record(Schema.String, Schema.String),
});
const encodeGraphQlRequest = Schema.encodeSync(Schema.fromJsonString(GitLabGraphQlRequestSchema));

/** A GraphQL request as `glab api graphql --input -` takes it. */
export function buildGitLabGraphQlRequestJson(input: {
  readonly query: string;
  readonly variables: Readonly<Record<string, string>>;
}): string {
  return encodeGraphQlRequest({ query: input.query, variables: { ...input.variables } });
}
