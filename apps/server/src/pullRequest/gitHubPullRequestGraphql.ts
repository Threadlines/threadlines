import type * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type {
  PullRequestActor,
  PullRequestListState,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewCommentDraft,
  PullRequestReviewerCandidate,
  PullRequestReviewerCandidateList,
  PullRequestReviewerKind,
  PullRequestReviewPosition,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
} from "@threadlines/contracts";
import { decodeJsonResult } from "@threadlines/shared/schemaJson";

import {
  decodeGitHubPullRequestListRow,
  nonEmptyText,
  normalizeActor,
  GitHubAuthorSchema,
  type GitHubPullRequestListRow,
} from "./gitHubPullRequestList.ts";

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

/** GitHub's own ceiling on a connection page, which is what every read here asks for. */
const GRAPHQL_PAGE_SIZE = 100;

/**
 * The reaction counts on one node. `users { totalCount }` is the whole tally;
 * `viewerHasReacted` is the reader's own place in it.
 */
const REACTION_GROUPS_FIELDS = "reactionGroups { content viewerHasReacted users { totalCount } }";

/**
 * Everything the conversation needs that `gh pr view --json` cannot report: the
 * review threads on diff lines, and the reactions and authorship marks on the
 * pull request and on every remark in it. One document, one request per
 * activity read.
 */
export const PULL_REQUEST_CONVERSATION_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${REACTION_GROUPS_FIELDS}
      reviewThreads(first: ${GRAPHQL_PAGE_SIZE}) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          diffSide
          comments(first: ${GRAPHQL_PAGE_SIZE}) {
            nodes {
              id
              author { login avatarUrl }
              body
              createdAt
              url
              viewerDidAuthor
              ${REACTION_GROUPS_FIELDS}
            }
          }
        }
      }
      comments(first: ${GRAPHQL_PAGE_SIZE}) {
        nodes { id viewerDidAuthor author { login avatarUrl } ${REACTION_GROUPS_FIELDS} }
      }
      reviews(first: ${GRAPHQL_PAGE_SIZE}) {
        nodes { id viewerDidAuthor author { login avatarUrl } ${REACTION_GROUPS_FIELDS} }
      }
    }
  }
}`;

/**
 * How far the head branch trails its base.
 *
 * `mergeStateStatus` is not the answer: GitHub only reports BEHIND where the
 * repository requires branches to be current before merging. The comparison
 * counts the commits instead, which is the number GitHub's own banner shows.
 *
 * `headRef` is qualified `owner:branch` because a branch on a fork has no name
 * of its own in the base repository.
 */
export const BASE_COMPARISON_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $headRef: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      baseRef { compare(headRef: $headRef) { behindBy } }
    }
  }
}`;

/** Labels and outstanding review requests are short lists; this is room to spare. */
const AUTHORED_CONNECTION_PAGE_SIZE = 20;

/**
 * The viewer's own pull requests across the whole host, wherever they are. One
 * search stands in for a listing per repository, which is the only way to reach
 * a contribution to a repository nobody here has checked out.
 *
 * `first` is a variable so the listing asks for as many rows as it would from a
 * repository. The fields are the ones a list row is built from, plus the
 * repository each one is on, what the viewer may do there, and the check rollup
 * of its last commit, since a search cannot be asked for `statusCheckRollup`
 * the way `gh pr list` is.
 */
export const AUTHORED_PULL_REQUESTS_GRAPHQL_QUERY = `query($q: String!, $first: Int!) {
  search(query: $q, type: ISSUE, first: $first) {
    nodes {
      ... on PullRequest {
        number
        title
        url
        isDraft
        state
        mergedAt
        createdAt
        updatedAt
        headRefName
        baseRefName
        additions
        deletions
        mergeable
        reviewDecision
        autoMergeRequest { enabledAt }
        author { login avatarUrl }
        repository { nameWithOwner viewerPermission }
        labels(first: ${AUTHORED_CONNECTION_PAGE_SIZE}) { nodes { name color } }
        reviewRequests(first: ${AUTHORED_CONNECTION_PAGE_SIZE}) {
          nodes { requestedReviewer { ... on User { login } } }
        }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

/**
 * GitHub counts a merged pull request as closed as well, so the closed slice
 * has to say it is the unmerged half of that.
 */
const AUTHORED_SEARCH_STATE: Readonly<Record<PullRequestListState, string>> = {
  open: "is:open",
  merged: "is:merged",
  closed: "is:closed is:unmerged",
};

/** The search phrase {@link AUTHORED_PULL_REQUESTS_GRAPHQL_QUERY} runs. */
export function gitHubAuthoredSearchQuery(input: {
  readonly viewer: string;
  readonly state: PullRequestListState;
}): string {
  return `is:pr author:${input.viewer.trim()} ${AUTHORED_SEARCH_STATE[input.state]}`;
}

/** The people this pull request may be sent to, with whoever is on it already marked. */
export const REVIEWER_CANDIDATES_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    assignableUsers(first: ${GRAPHQL_PAGE_SIZE}) {
      nodes { login name avatarUrl }
    }
    pullRequest(number: $number) {
      author { login }
      reviewRequests(first: ${GRAPHQL_PAGE_SIZE}) {
        nodes {
          requestedReviewer {
            ... on User { login name avatarUrl }
            ... on Team { slug name avatarUrl }
            ... on Bot { login avatarUrl }
          }
        }
      }
    }
  }
}`;

/**
 * The pull request's own node id, which is what a reaction on its description
 * is addressed by. Read only when one is being written: the conversation
 * carries an id for every remark in it, and the pull request is the one subject
 * nothing in it names.
 */
export const PULL_REQUEST_NODE_ID_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`;

/**
 * Where a client-given subject actually hangs. A subject id is trusted to be
 * whatever node it names, and that node can belong to any pull request on the
 * host, so the mutation would write wherever the id really points unless this
 * confirms the two agree first.
 */
export const REACTION_SUBJECT_SCOPE_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $subjectId: ID!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
  node(id: $subjectId) {
    id
    ... on IssueComment { pullRequest { id } }
    ... on PullRequestReviewComment { pullRequest { id } }
    ... on PullRequestReview { pullRequest { id } }
  }
}`;

export const ADD_REACTION_GRAPHQL_MUTATION = `mutation($subjectId: ID!, $content: ReactionContent!) {
  addReaction(input: { subjectId: $subjectId, content: $content }) { reaction { content } }
}`;

export const REMOVE_REACTION_GRAPHQL_MUTATION = `mutation($subjectId: ID!, $content: ReactionContent!) {
  removeReaction(input: { subjectId: $subjectId, content: $content }) { reaction { content } }
}`;

export const RESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
}`;

export const UNRESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION = `mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
}`;

export const REVIEW_THREAD_REPLY_GRAPHQL_MUTATION = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id }
  }
}`;

/**
 * The two comment mutations name their comment differently, but the variable is
 * spelled the same in both, so a rewrite sends one set of variables whichever
 * kind of remark it is.
 */
export const UPDATE_ISSUE_COMMENT_GRAPHQL_MUTATION = `mutation($commentId: ID!, $body: String!) {
  updateIssueComment(input: { id: $commentId, body: $body }) { issueComment { id } }
}`;

export const UPDATE_REVIEW_COMMENT_GRAPHQL_MUTATION = `mutation($commentId: ID!, $body: String!) {
  updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $commentId, body: $body }) {
    pullRequestReviewComment { id }
  }
}`;

/** A list of ids is a variable too: one read asks about a batch of accounts. */
export type GitHubGraphQlVariable = string | number | boolean | null | ReadonlyArray<string>;

const GraphQlRequestSchema = Schema.Struct({
  query: Schema.String,
  variables: Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.String,
      Schema.Number,
      Schema.Boolean,
      Schema.Null,
      Schema.Array(Schema.String),
    ]),
  ),
});

const encodeGraphQlRequest = Schema.encodeSync(Schema.fromJsonString(GraphQlRequestSchema));

/**
 * A GraphQL request as `gh api graphql --input -` takes it. Document and
 * variables travel together on stdin, so a reader's own words never reach argv,
 * where they would show up in process listings and in failure messages.
 */
export function encodeGraphQlRequestJson(input: {
  readonly query: string;
  readonly variables: Readonly<Record<string, GitHubGraphQlVariable>>;
}): string {
  return encodeGraphQlRequest({ query: input.query, variables: { ...input.variables } });
}

const REACTION_CONTENT_BY_GITHUB: Readonly<Record<string, PullRequestReactionContent>> = {
  THUMBS_UP: "thumbs-up",
  THUMBS_DOWN: "thumbs-down",
  LAUGH: "laugh",
  HOORAY: "hooray",
  CONFUSED: "confused",
  HEART: "heart",
  ROCKET: "rocket",
  EYES: "eyes",
};

const GITHUB_REACTION_BY_CONTENT: Readonly<Record<PullRequestReactionContent, string>> = {
  "thumbs-up": "THUMBS_UP",
  "thumbs-down": "THUMBS_DOWN",
  laugh: "LAUGH",
  hooray: "HOORAY",
  confused: "CONFUSED",
  heart: "HEART",
  rocket: "ROCKET",
  eyes: "EYES",
};

/** The enum value a reaction mutation names this reaction by. */
export function gitHubReactionContent(content: PullRequestReactionContent): string {
  return GITHUB_REACTION_BY_CONTENT[content];
}

const RawReactionGroupsSchema = Schema.optional(
  Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        content: Schema.optional(Schema.NullOr(Schema.String)),
        viewerHasReacted: Schema.optional(Schema.NullOr(Schema.Boolean)),
        users: Schema.optional(
          Schema.NullOr(
            Schema.Struct({ totalCount: Schema.optional(Schema.NullOr(Schema.Number)) }),
          ),
        ),
      }),
    ),
  ),
);

type RawReactionGroups = typeof RawReactionGroupsSchema.Type;

/**
 * The groups GitHub answered with, as the contract carries them. A group nobody
 * chose is dropped: GitHub answers with a group per content it knows, including
 * every empty one.
 */
function toReactions(groups: RawReactionGroups): ReadonlyArray<PullRequestReaction> {
  const reactions: PullRequestReaction[] = [];
  for (const group of groups ?? []) {
    const content = REACTION_CONTENT_BY_GITHUB[nonEmptyText(group.content)?.toUpperCase() ?? ""];
    const count = Math.trunc(group.users?.totalCount ?? 0);
    if (content === undefined || count <= 0) {
      continue;
    }
    reactions.push({ content, count, viewerReacted: group.viewerHasReacted === true });
  }
  return reactions;
}

const RawThreadCommentSchema = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(GitHubAuthorSchema)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  url: Schema.optional(Schema.NullOr(Schema.String)),
  viewerDidAuthor: Schema.optional(Schema.NullOr(Schema.Boolean)),
  reactionGroups: RawReactionGroupsSchema,
});

const RawAnnotatedNodeSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  viewerDidAuthor: Schema.optional(Schema.NullOr(Schema.Boolean)),
  author: Schema.optional(Schema.NullOr(GitHubAuthorSchema)),
  reactionGroups: RawReactionGroupsSchema,
});

const RawConversationSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            reactionGroups: RawReactionGroupsSchema,
            reviewThreads: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  nodes: Schema.Array(
                    Schema.NullOr(
                      Schema.Struct({
                        id: Schema.optional(Schema.NullOr(Schema.String)),
                        isResolved: Schema.optional(Schema.NullOr(Schema.Boolean)),
                        isOutdated: Schema.optional(Schema.NullOr(Schema.Boolean)),
                        path: Schema.optional(Schema.NullOr(Schema.String)),
                        line: Schema.optional(Schema.NullOr(Schema.Number)),
                        diffSide: Schema.optional(Schema.NullOr(Schema.String)),
                        comments: Schema.optional(
                          Schema.NullOr(
                            Schema.Struct({ nodes: Schema.Array(RawThreadCommentSchema) }),
                          ),
                        ),
                      }),
                    ),
                  ),
                }),
              ),
            ),
            comments: Schema.optional(
              Schema.NullOr(Schema.Struct({ nodes: Schema.Array(RawAnnotatedNodeSchema) })),
            ),
            reviews: Schema.optional(
              Schema.NullOr(Schema.Struct({ nodes: Schema.Array(RawAnnotatedNodeSchema) })),
            ),
          }),
        ),
      }),
    ),
  }),
});

/** What a GraphQL read adds to a remark `gh pr view --json` already reported. */
export interface GitHubCommentAnnotation {
  readonly reactions: ReadonlyArray<PullRequestReaction>;
  readonly viewerIsAuthor: boolean;
  /** The author with their picture, which `gh pr view --json` never carries. */
  readonly author: PullRequestActor | null;
}

/** Everything one activity read learns from GraphQL, keyed the way it is used. */
export interface GitHubPullRequestConversation {
  readonly reviewThreads: ReadonlyArray<PullRequestReviewThread>;
  /** The pull request description's own reactions. */
  readonly reactions: ReadonlyArray<PullRequestReaction>;
  /** Keyed by the node id `gh pr view --json` reports for the same remark. */
  readonly annotationsByCommentId: ReadonlyMap<string, GitHubCommentAnnotation>;
}

const decodeConversation = decodeJsonResult(RawConversationSchema);

/**
 * Decodes the one GraphQL read an activity makes: the line conversations, plus
 * the reactions and authorship marks for the remarks the JSON read carries.
 *
 * A thread with no id, no path, or no comments is dropped rather than rendered
 * as an empty card. `line` is null once the line the thread hung on has left
 * the diff, which is exactly when GitHub reports the thread outdated.
 */
export function decodeGitHubPullRequestConversationJson(
  raw: string,
): Result.Result<GitHubPullRequestConversation, DecodeFailure> {
  const decoded = decodeConversation(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }

  const pullRequest = decoded.success.data.repository?.pullRequest ?? null;
  const reviewThreads = (pullRequest?.reviewThreads?.nodes ?? []).flatMap(
    (thread): ReadonlyArray<PullRequestReviewThread> => {
      const id = nonEmptyText(thread?.id);
      const path = nonEmptyText(thread?.path);
      const comments = thread?.comments?.nodes ?? [];
      if (id === null || path === null || comments.length === 0) {
        return [];
      }
      const line = thread?.line ?? null;
      return [
        {
          id,
          path,
          line: line !== null && line > 0 ? Math.trunc(line) : null,
          side: thread?.diffSide?.trim().toUpperCase() === "LEFT" ? "left" : "right",
          isResolved: thread?.isResolved === true,
          isOutdated: thread?.isOutdated === true,
          comments: comments.map((comment) => ({
            id: comment.id,
            author: normalizeActor(comment.author),
            body: comment.body ?? "",
            createdAt: comment.createdAt,
            url: nonEmptyText(comment.url),
            reactions: toReactions(comment.reactionGroups),
            viewerIsAuthor: comment.viewerDidAuthor === true,
          })),
        },
      ];
    },
  );

  const annotationsByCommentId = new Map<string, GitHubCommentAnnotation>();
  for (const node of [
    ...(pullRequest?.comments?.nodes ?? []),
    ...(pullRequest?.reviews?.nodes ?? []),
  ]) {
    const id = nonEmptyText(node.id);
    if (id === null) {
      continue;
    }
    annotationsByCommentId.set(id, {
      reactions: toReactions(node.reactionGroups),
      viewerIsAuthor: node.viewerDidAuthor === true,
      author: normalizeActor(node.author),
    });
  }

  return Result.succeed({
    reviewThreads,
    reactions: toReactions(pullRequest?.reactionGroups),
    annotationsByCommentId,
  });
}

const RawBaseComparisonSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            /** Null where the head repository is gone, a comparison nobody can make. */
            baseRef: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  compare: Schema.optional(
                    Schema.NullOr(
                      Schema.Struct({ behindBy: Schema.optional(Schema.NullOr(Schema.Number)) }),
                    ),
                  ),
                }),
              ),
            ),
          }),
        ),
      }),
    ),
  }),
});

const decodeBaseComparison = decodeJsonResult(RawBaseComparisonSchema);

/** How many commits the base has that the head does not; null when unanswerable. */
export function decodeGitHubBaseComparisonJson(
  raw: string,
): Result.Result<number | null, DecodeFailure> {
  const decoded = decodeBaseComparison(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const behindBy = decoded.success.data.repository?.pullRequest?.baseRef?.compare?.behindBy;
  return Result.succeed(
    typeof behindBy === "number" && behindBy >= 0 ? Math.trunc(behindBy) : null,
  );
}

const RawAuthoredNodeSchema = Schema.Struct({
  number: Schema.optional(Schema.NullOr(Schema.Number)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  headRefName: Schema.optional(Schema.NullOr(Schema.String)),
  baseRefName: Schema.optional(Schema.NullOr(Schema.String)),
  additions: Schema.optional(Schema.NullOr(Schema.Number)),
  deletions: Schema.optional(Schema.NullOr(Schema.Number)),
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  autoMergeRequest: Schema.optional(Schema.NullOr(Schema.Struct({}))),
  author: Schema.optional(Schema.NullOr(GitHubAuthorSchema)),
  repository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nameWithOwner: Schema.optional(Schema.NullOr(Schema.String)),
        viewerPermission: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  labels: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(
          Schema.NullOr(
            Schema.Struct({
              name: Schema.optional(Schema.NullOr(Schema.String)),
              color: Schema.optional(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      }),
    ),
  ),
  reviewRequests: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(
          Schema.NullOr(
            Schema.Struct({
              requestedReviewer: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({ login: Schema.optional(Schema.NullOr(Schema.String)) }),
                ),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
  commits: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(
          Schema.NullOr(
            Schema.Struct({
              commit: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    statusCheckRollup: Schema.optional(
                      Schema.NullOr(
                        Schema.Struct({ state: Schema.optional(Schema.NullOr(Schema.String)) }),
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
});

type RawAuthoredNode = typeof RawAuthoredNodeSchema.Type;

const RawAuthoredSearchSchema = Schema.Struct({
  data: Schema.Struct({
    search: Schema.NullOr(
      Schema.Struct({ nodes: Schema.Array(Schema.NullOr(RawAuthoredNodeSchema)) }),
    ),
  }),
});

const decodeAuthoredSearch = decodeJsonResult(RawAuthoredSearchSchema);

/** One of the viewer's own pull requests, and the repository it is on. */
export interface GitHubAuthoredPullRequestRow extends GitHubPullRequestListRow {
  readonly repository: string;
  /** Absent where the search named no permission on the repository. */
  readonly viewerCanWrite?: boolean;
}

/**
 * Whether a `RepositoryPermission` is push access, or null where GitHub named
 * none. Admin and maintain both include write; triage and read do not, and
 * anything unrecognised is treated as an answer we do not have.
 */
function toViewerCanWrite(permission: string | null | undefined): boolean | null {
  switch (nonEmptyText(permission)?.toUpperCase() ?? null) {
    case "ADMIN":
    case "MAINTAIN":
    case "WRITE":
      return true;
    case "READ":
    case "TRIAGE":
      return false;
    default:
      return null;
  }
}

/**
 * A search node in the shape `gh pr list --json` reports, so one decoder
 * normalises both listings. The rollup arrives as the single verdict GitHub
 * already summed rather than the per-check array `gh` hands over, so it travels
 * as the one check it stands for; a label with no name and a team review
 * request both survive the trip and are dropped where the list drops them.
 */
function toGitHubListRowShape(node: RawAuthoredNode): unknown {
  const rollupState = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    author: node.author,
    headRefName: node.headRefName,
    baseRefName: node.baseRefName,
    state: node.state,
    mergedAt: node.mergedAt,
    isDraft: node.isDraft,
    additions: node.additions,
    deletions: node.deletions,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    mergeable: node.mergeable,
    reviewDecision: node.reviewDecision,
    autoMergeRequest: node.autoMergeRequest,
    reviewRequests: (node.reviewRequests?.nodes ?? []).map((request) => ({
      login: request?.requestedReviewer?.login ?? null,
    })),
    labels: (node.labels?.nodes ?? []).map((label) => ({
      name: label?.name ?? "",
      color: label?.color ?? null,
    })),
    statusCheckRollup: rollupState === null ? null : [{ state: rollupState }],
  };
}

/**
 * Decodes the authored search. `type: ISSUE` answers with issues as well as
 * pull requests, and a node that is neither in the shape a row needs, nor on a
 * repository it can name, is dropped rather than failing the whole search.
 */
export function decodeGitHubAuthoredPullRequestsJson(
  raw: string,
): Result.Result<ReadonlyArray<GitHubAuthoredPullRequestRow>, DecodeFailure> {
  const decoded = decodeAuthoredSearch(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }

  const rows: GitHubAuthoredPullRequestRow[] = [];
  for (const node of decoded.success.data.search?.nodes ?? []) {
    const repository = nonEmptyText(node?.repository?.nameWithOwner);
    if (node === null || repository === null) {
      continue;
    }
    const row = decodeGitHubPullRequestListRow(toGitHubListRowShape(node));
    if (row !== null) {
      const viewerCanWrite = toViewerCanWrite(node.repository?.viewerPermission);
      rows.push({
        ...row,
        repository,
        ...(viewerCanWrite === null ? {} : { viewerCanWrite }),
      });
    }
  }
  return Result.succeed(rows);
}

const RawPullRequestNodeIdSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(Schema.Struct({ id: Schema.String })),
      }),
    ),
  }),
});

const decodePullRequestNodeId = decodeJsonResult(RawPullRequestNodeIdSchema);

/** The pull request's node id, or null when the host would not name one. */
export function decodeGitHubPullRequestNodeIdJson(
  raw: string,
): Result.Result<string | null, DecodeFailure> {
  const decoded = decodePullRequestNodeId(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(nonEmptyText(decoded.success.data.repository?.pullRequest?.id))
    : Result.fail(decoded.failure);
}

const RawReactionSubjectScopeSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({ pullRequest: Schema.NullOr(Schema.Struct({ id: Schema.String })) }),
    ),
    node: Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        pullRequest: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
      }),
    ),
  }),
});

const decodeReactionSubjectScope = decodeJsonResult(RawReactionSubjectScopeSchema);

/**
 * True when the subject named is this pull request, or hangs off it. False for
 * anything else, including a subject or a pull request the host could not find.
 */
export function decodeGitHubSubjectScopeJson(raw: string): Result.Result<boolean, DecodeFailure> {
  const decoded = decodeReactionSubjectScope(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const expected = decoded.success.data.repository?.pullRequest?.id ?? null;
  const node = decoded.success.data.node;
  const actual = node === null ? null : (node.pullRequest?.id ?? node.id);
  return Result.succeed(expected !== null && actual !== null && expected === actual);
}

const RawRequestedReviewerSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
  slug: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewerCandidatesSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        assignableUsers: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              nodes: Schema.Array(Schema.NullOr(RawRequestedReviewerSchema)),
            }),
          ),
        ),
        pullRequest: Schema.NullOr(
          Schema.Struct({
            author: Schema.optional(Schema.NullOr(GitHubAuthorSchema)),
            reviewRequests: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  nodes: Schema.Array(
                    Schema.Struct({
                      requestedReviewer: Schema.optional(Schema.NullOr(RawRequestedReviewerSchema)),
                    }),
                  ),
                }),
              ),
            ),
          }),
        ),
      }),
    ),
  }),
});

const decodeReviewerCandidates = decodeJsonResult(RawReviewerCandidatesSchema);

/**
 * The people this pull request may be sent to. Whoever has already been asked
 * leads the list even where GitHub does not count them assignable, because a
 * request that cannot be seen cannot be taken back. The author is dropped
 * rather than offered as a row the host would refuse.
 */
export function decodeGitHubReviewerCandidatesJson(
  raw: string,
): Result.Result<PullRequestReviewerCandidateList, DecodeFailure> {
  const decoded = decodeReviewerCandidates(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }

  const repository = decoded.success.data.repository;
  const pullRequest = repository?.pullRequest ?? null;
  const author = nonEmptyText(pullRequest?.author?.login)?.toLowerCase() ?? null;
  const candidates = new Map<string, PullRequestReviewerCandidate>();

  for (const node of pullRequest?.reviewRequests?.nodes ?? []) {
    const slug = nonEmptyText(node.requestedReviewer?.slug);
    const id = slug ?? nonEmptyText(node.requestedReviewer?.login);
    if (id === null) {
      continue;
    }
    const kind: PullRequestReviewerKind = slug === null ? "user" : "team";
    candidates.set(`${kind}:${id.toLowerCase()}`, {
      id,
      kind,
      login: id,
      name: nonEmptyText(node.requestedReviewer?.name),
      avatarUrl: nonEmptyText(node.requestedReviewer?.avatarUrl),
      requested: true,
    });
  }

  for (const node of repository?.assignableUsers?.nodes ?? []) {
    const login = nonEmptyText(node?.login);
    if (login === null || login.toLowerCase() === author) {
      continue;
    }
    const key = `user:${login.toLowerCase()}`;
    if (candidates.has(key)) {
      continue;
    }
    candidates.set(key, {
      id: login,
      kind: "user",
      login,
      name: nonEmptyText(node?.name),
      avatarUrl: nonEmptyText(node?.avatarUrl),
      requested: false,
    });
  }

  return Result.succeed({ candidates: [...candidates.values()] });
}

/** The body of `POST /repos/{owner}/{repo}/pulls/{number}/reviews`, which sends a review whole. */
const ReviewSubmissionSchema = Schema.Struct({
  event: Schema.Literals(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
  body: Schema.String,
  comments: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      line: Schema.Number,
      side: Schema.Literals(["LEFT", "RIGHT"]),
      body: Schema.String,
    }),
  ),
});

const encodeReviewSubmission = Schema.encodeSync(Schema.fromJsonString(ReviewSubmissionSchema));

const REVIEW_EVENTS: Readonly<
  Record<PullRequestReviewVerdict, "COMMENT" | "APPROVE" | "REQUEST_CHANGES">
> = {
  comment: "COMMENT",
  approve: "APPROVE",
  "request-changes": "REQUEST_CHANGES",
};

/**
 * A line the change added exists only on the right, a line it deleted only on
 * the left, and a context line on whichever side the reader picked it from.
 */
function gitHubReviewPosition(position: PullRequestReviewPosition): {
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
} {
  switch (position.kind) {
    case "added":
      return { line: position.newLine, side: "RIGHT" };
    case "deleted":
      return { line: position.oldLine, side: "LEFT" };
    case "context":
      return position.side === "left"
        ? { line: position.oldLine, side: "LEFT" }
        : { line: position.newLine, side: "RIGHT" };
  }
}

/** The whole review as one request body, which is how GitHub keeps it unsent until it is. */
export function buildGitHubReviewSubmissionJson(input: {
  readonly verdict: PullRequestReviewVerdict;
  readonly body: string;
  readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
}): string {
  return encodeReviewSubmission({
    event: REVIEW_EVENTS[input.verdict],
    body: input.body,
    comments: input.comments.map((comment) => ({
      path: comment.path,
      ...gitHubReviewPosition(comment.position),
      body: comment.body,
    })),
  });
}

/**
 * The body of `POST`/`DELETE /repos/{owner}/{repo}/pulls/{number}/requested_reviewers`,
 * which takes people and teams in two lists of its own. The same body serves
 * both methods, because GitHub takes a request back from whoever it was made of.
 */
const ReviewerRequestSchema = Schema.Struct({
  reviewers: Schema.Array(Schema.String),
  team_reviewers: Schema.Array(Schema.String),
});

const encodeReviewerRequest = Schema.encodeSync(Schema.fromJsonString(ReviewerRequestSchema));

export function buildGitHubReviewerRequestJson(
  reviewers: ReadonlyArray<{ readonly id: string; readonly kind: PullRequestReviewerKind }>,
): string {
  return encodeReviewerRequest({
    reviewers: reviewers.flatMap((reviewer) => (reviewer.kind === "user" ? [reviewer.id] : [])),
    team_reviewers: reviewers.flatMap((reviewer) =>
      reviewer.kind === "team" ? [reviewer.id] : [],
    ),
  });
}
