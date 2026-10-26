/**
 * How fast the sidebar's on-screen pull requests are read (pullRequestWatch.ts):
 * the pace for each, and which of them go in one request.
 */
import type { PullRequestChecksState, PullRequestState } from "@threadlines/contracts";

export const PULL_REQUEST_WATCH_BUSY_MS = 30_000;
export const PULL_REQUEST_WATCH_QUIET_MS = 90_000;
export const PULL_REQUEST_WATCH_CLOSED_MS = 300_000;
/** A pull request the host changed this recently is still in motion. */
const PULL_REQUEST_WATCH_RECENT_MS = 10 * 60_000;

/** How often a watched pull request is read, or null for one that cannot change. */
export function pullRequestWatchIntervalMs(input: {
  /** Null until anything has read it. */
  readonly state: PullRequestState | null;
  readonly autoMergeEnabled: boolean;
  readonly checksState: PullRequestChecksState | null;
  readonly busy: boolean;
  /** How long ago the host last changed it, where a read said. */
  readonly updatedAgoMs: number | null;
}): number | null {
  if (input.state === "merged") return null;
  if (input.state === "closed") return PULL_REQUEST_WATCH_CLOSED_MS;
  const moving =
    input.busy ||
    input.autoMergeEnabled ||
    input.checksState === "pending" ||
    (input.updatedAgoMs !== null && input.updatedAgoMs < PULL_REQUEST_WATCH_RECENT_MS);
  return moving ? PULL_REQUEST_WATCH_BUSY_MS : PULL_REQUEST_WATCH_QUIET_MS;
}

/** One watched pull request as the schedule weighs it. */
export interface PullRequestWatchEntry<A> {
  readonly value: A;
  /** Pull requests that travel in one request: same computer, project and repository. */
  readonly batchKey: string;
  readonly intervalMs: number;
  /** Since its last answer; infinite before the first. */
  readonly ageMs: number;
}

/**
 * Which pull requests to read now: in each batch where one is due, every one
 * at least halfway to due goes along, so one request serves them all and the
 * batch's paces fall into step instead of each costing its own request.
 */
export function duePullRequestWatches<A>(
  entries: readonly PullRequestWatchEntry<A>[],
): readonly A[] {
  const batches = new Map<string, PullRequestWatchEntry<A>[]>();
  for (const entry of entries) {
    const batch = batches.get(entry.batchKey) ?? [];
    batch.push(entry);
    batches.set(entry.batchKey, batch);
  }
  const due: A[] = [];
  for (const batch of batches.values()) {
    if (!batch.some((entry) => entry.ageMs >= entry.intervalMs)) continue;
    for (const entry of batch) {
      if (entry.ageMs >= entry.intervalMs / 2) due.push(entry.value);
    }
  }
  return due;
}
