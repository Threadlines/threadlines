/**
 * A review being written, held until it is sent.
 *
 * Nothing here reaches the host: a review is one request carrying every line
 * comment and the verdict together, so a half-written one is invisible to
 * everyone else. It survives a tab switch and a panel remount, which is why it
 * is a store rather than component state, and deliberately does not survive a
 * reload.
 */
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestReviewCommentDraft,
} from "@threadlines/contracts";
import { create } from "zustand";

export type PendingReviewComment = PullRequestReviewCommentDraft & { readonly id: string };

/**
 * A counter rather than anything derived from the comment: two remarks on one
 * line can read the same, and an id built from the words would collide with a
 * comment already discarded, which shares a React key with it.
 */
let pendingCommentSequence = 0;

export function nextPendingReviewCommentId(): string {
  pendingCommentSequence += 1;
  return `pending-review-comment-${pendingCommentSequence}`;
}

/**
 * One pull request's draft. Scoped by computer as well as by project: two
 * servers hand out project ids of their own, and a repository can be checked
 * out twice on either of them.
 */
export function pullRequestReviewKey(
  environmentId: EnvironmentId,
  reference: PullRequestRef,
): string {
  return `${environmentId}/${reference.projectId}/${reference.repository}#${reference.number}`;
}

interface PullRequestReviewStoreState {
  readonly comments: Readonly<Record<string, readonly PendingReviewComment[]>>;
  readonly summaries: Readonly<Record<string, string>>;
  readonly addComment: (key: string, comment: PendingReviewComment) => void;
  readonly editComment: (key: string, commentId: string, body: string) => void;
  readonly removeComment: (key: string, commentId: string) => void;
  /** Drops exactly what the host accepted, leaving anything added since. */
  readonly clearSubmitted: (
    key: string,
    commentIds: readonly string[],
    submittedSummary: string,
  ) => void;
  readonly discard: (key: string) => void;
  readonly setSummary: (key: string, body: string) => void;
}

const EMPTY: readonly PendingReviewComment[] = [];

function withoutKey(
  record: Readonly<Record<string, readonly PendingReviewComment[]>>,
  key: string,
): Readonly<Record<string, readonly PendingReviewComment[]>> {
  const { [key]: _dropped, ...rest } = record;
  return rest;
}

export const usePullRequestReviewStore = create<PullRequestReviewStoreState>()((set) => ({
  comments: {},
  summaries: {},
  addComment: (key, comment) =>
    set((state) => ({
      comments: { ...state.comments, [key]: [...(state.comments[key] ?? EMPTY), comment] },
    })),
  editComment: (key, commentId, body) =>
    set((state) => ({
      comments: {
        ...state.comments,
        [key]: (state.comments[key] ?? EMPTY).map((entry) =>
          entry.id === commentId ? { ...entry, body } : entry,
        ),
      },
    })),
  removeComment: (key, commentId) =>
    set((state) => {
      const remaining = (state.comments[key] ?? EMPTY).filter((entry) => entry.id !== commentId);
      return {
        comments:
          remaining.length > 0
            ? { ...state.comments, [key]: remaining }
            : withoutKey(state.comments, key),
      };
    }),
  clearSubmitted: (key, commentIds, submittedSummary) =>
    set((state) => {
      const submitted = new Set(commentIds);
      const remaining = (state.comments[key] ?? EMPTY).filter((entry) => !submitted.has(entry.id));
      // The summary box stays editable while the request is in flight, so only
      // the exact words the host took are cleared; a revised summary is new work.
      const summaries =
        state.summaries[key] === submittedSummary
          ? Object.fromEntries(Object.entries(state.summaries).filter(([entry]) => entry !== key))
          : state.summaries;
      return {
        comments:
          remaining.length > 0
            ? { ...state.comments, [key]: remaining }
            : withoutKey(state.comments, key),
        summaries,
      };
    }),
  discard: (key) =>
    set((state) => ({
      comments: withoutKey(state.comments, key),
      summaries: Object.fromEntries(
        Object.entries(state.summaries).filter(([entry]) => entry !== key),
      ),
    })),
  setSummary: (key, body) => set((state) => ({ summaries: { ...state.summaries, [key]: body } })),
}));

/** The comments a pull request's draft holds, stable across renders while empty. */
export function usePendingReviewComments(
  environmentId: EnvironmentId,
  reference: PullRequestRef,
): readonly PendingReviewComment[] {
  return usePullRequestReviewStore(
    (store) => store.comments[pullRequestReviewKey(environmentId, reference)] ?? EMPTY,
  );
}
