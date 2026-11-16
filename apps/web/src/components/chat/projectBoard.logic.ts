import type { ThreadStatusPill } from "../Sidebar.logic";
import type { PullRequestNeedsYouReason } from "../pull-requests/pullRequests.logic";
import { THREAD_STATUS_PRESENTATION } from "./threadStatusGroups";

/**
 * The Threads panel's sorting of a project's threads by what needs the user
 * (docs/design/lead-chat.md, "Threads panel"). Pure, so the board is tested as
 * data and the panel only paints it.
 */

export type ProjectBoardGroupId =
  | "needsYou"
  | "readyForReview"
  | "working"
  | "landing"
  | "idle"
  | "done";

/** The order the groups are drawn in. A thread is placed by a different order; see `placeThread`. */
export const PROJECT_BOARD_GROUP_ORDER: readonly ProjectBoardGroupId[] = [
  "needsYou",
  "readyForReview",
  "working",
  "landing",
  "idle",
  "done",
];

export const PROJECT_BOARD_GROUP_LABELS: Readonly<Record<ProjectBoardGroupId, string>> = {
  needsYou: "Needs you",
  readyForReview: "Ready for review",
  working: "Working",
  landing: "Landing",
  idle: "Idle",
  done: "Done",
};

/** Wrapped longer ago than this and a thread is off the board. */
export const PROJECT_BOARD_DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

/** More rows than this in a group and the rest fold behind "Show N more". */
export const PROJECT_BOARD_GROUP_FOLD_AT = 8;

/** One of a thread's pull requests, as much as the board reads of it. */
export interface ProjectBoardPullRequestInput {
  readonly state: "open" | "merged" | "closed";
  readonly isDraft: boolean;
  /** Armed to land on its own, or already in the merge queue. */
  readonly autoMergeEnabled: boolean;
  /** What the Pull requests page says it waits on, from the open listing; null when nothing. */
  readonly reviewReason: PullRequestNeedsYouReason | null;
}

export interface ProjectBoardThreadInput {
  readonly key: string;
  /** The sidebar's status for the thread, or null when it shows none. */
  readonly statusLabel: ThreadStatusPill["label"] | null;
  /** The sidebar files it under Wrapped (`InboxEntry.isDone`). */
  readonly isDone: boolean;
  /** When it was wrapped; null while not, or when that is not known. */
  readonly doneAt: string | null;
  /** When it last moved, newest first within a group. */
  readonly activityAt: string;
  /** Its own pull request first, then the ones its agent opened elsewhere. */
  readonly pullRequests: readonly ProjectBoardPullRequestInput[];
}

export interface ProjectBoardRow<T extends ProjectBoardThreadInput> {
  readonly thread: T;
  /**
   * The row's word in place of its status, from its pull request: why it
   * waits for review, or that it is landing. Null leaves the thread's own
   * status words.
   */
  readonly pullRequestWord: string | null;
}

export interface ProjectBoardGroup<T extends ProjectBoardThreadInput> {
  readonly id: ProjectBoardGroupId;
  readonly label: string;
  readonly rows: readonly ProjectBoardRow<T>[];
}

export interface ProjectBoardCounts {
  readonly needsYou: number;
  readonly readyForReview: number;
  readonly working: number;
}

function timestampMs(iso: string | null): number {
  if (iso === null) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/** Its open, non-draft pull requests: the ones that put it up for review or landing. */
function reviewablePullRequests(
  thread: ProjectBoardThreadInput,
): readonly ProjectBoardPullRequestInput[] {
  return thread.pullRequests.filter(
    (pullRequest) => pullRequest.state === "open" && !pullRequest.isDraft,
  );
}

/** Landing or Ready for review, from its open pull requests; null when it has none up. */
function pullRequestPlacement(
  thread: ProjectBoardThreadInput,
): { readonly group: "landing" | "readyForReview"; readonly word: string | null } | null {
  const open = reviewablePullRequests(thread);
  if (open.length === 0) return null;
  if (open.some((pullRequest) => pullRequest.autoMergeEnabled)) {
    return { group: "landing", word: "auto-merge" };
  }
  const reason = open.find((pullRequest) => pullRequest.reviewReason !== null)?.reviewReason;
  return { group: "readyForReview", word: reason ? reason.toLowerCase() : null };
}

/**
 * Which group a thread goes in, the first that fits, or null when it is off
 * the board. Filing comes first: "Wrapped" is the sidebar's answer, not a
 * status, so a failed thread the user wrapped belongs in Done. The one
 * exception keeps review work in sight: a wrapped thread whose pull request is
 * still open (a finished child wraps itself the moment it hands back) goes to
 * Landing or Ready for review.
 */
function placeThread(
  thread: ProjectBoardThreadInput,
  nowMs: number,
): { readonly group: ProjectBoardGroupId; readonly word: string | null } | null {
  const pullRequest = pullRequestPlacement(thread);
  if (thread.isDone) {
    if (pullRequest !== null) return pullRequest;
    // An undated wrap is shown rather than guessed old.
    const wrappedMs = thread.doneAt === null ? nowMs : timestampMs(thread.doneAt);
    return nowMs - wrappedMs <= PROJECT_BOARD_DONE_WINDOW_MS ? { group: "done", word: null } : null;
  }
  const statusGroup =
    thread.statusLabel === null ? null : THREAD_STATUS_PRESENTATION[thread.statusLabel].group;
  if (statusGroup === "needsYou") return { group: "needsYou", word: null };
  if (statusGroup === "working") return { group: "working", word: null };
  return pullRequest ?? { group: "idle", word: null };
}

/**
 * The board: the groups that have anything in them, in drawing order, each
 * newest first (Done by when it was wrapped), and the header's counts.
 */
export function deriveProjectBoard<T extends ProjectBoardThreadInput>(
  threads: readonly T[],
  nowMs: number,
): { readonly groups: readonly ProjectBoardGroup<T>[]; readonly counts: ProjectBoardCounts } {
  const byGroup = new Map<ProjectBoardGroupId, ProjectBoardRow<T>[]>();
  for (const thread of threads) {
    const placement = placeThread(thread, nowMs);
    if (placement === null) continue;
    const rows = byGroup.get(placement.group) ?? [];
    rows.push({ thread, pullRequestWord: placement.word });
    byGroup.set(placement.group, rows);
  }
  const groups = PROJECT_BOARD_GROUP_ORDER.flatMap((id): ProjectBoardGroup<T>[] => {
    const rows = byGroup.get(id);
    if (rows === undefined) return [];
    const sortAt = (row: ProjectBoardRow<T>) =>
      timestampMs(
        id === "done" ? (row.thread.doneAt ?? row.thread.activityAt) : row.thread.activityAt,
      );
    return [
      {
        id,
        label: PROJECT_BOARD_GROUP_LABELS[id],
        rows: rows.toSorted(
          (left, right) =>
            sortAt(right) - sortAt(left) || left.thread.key.localeCompare(right.thread.key),
        ),
      },
    ];
  });
  return {
    groups,
    counts: {
      needsYou: byGroup.get("needsYou")?.length ?? 0,
      readyForReview: byGroup.get("readyForReview")?.length ?? 0,
      working: byGroup.get("working")?.length ?? 0,
    },
  };
}

/** A group's rows as drawn: the first few, and how many fold behind "Show N more". */
export function foldProjectBoardGroup<R>(
  rows: readonly R[],
  expanded: boolean,
): { readonly shown: readonly R[]; readonly hiddenCount: number } {
  if (expanded || rows.length <= PROJECT_BOARD_GROUP_FOLD_AT) {
    return { shown: rows, hiddenCount: 0 };
  }
  return {
    shown: rows.slice(0, PROJECT_BOARD_GROUP_FOLD_AT),
    hiddenCount: rows.length - PROJECT_BOARD_GROUP_FOLD_AT,
  };
}

/** The header's line: "2 need you · 1 to review · 3 working", or that nothing is going on. */
export function formatProjectBoardCounts(counts: ProjectBoardCounts): string {
  const parts: string[] = [];
  if (counts.needsYou > 0) {
    parts.push(counts.needsYou === 1 ? "1 needs you" : `${counts.needsYou} need you`);
  }
  if (counts.readyForReview > 0) parts.push(`${counts.readyForReview} to review`);
  if (counts.working > 0) parts.push(`${counts.working} working`);
  return parts.length === 0 ? "Nothing needs you" : parts.join(" · ");
}
