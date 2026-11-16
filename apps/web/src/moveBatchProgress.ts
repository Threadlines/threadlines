/**
 * How the latest batch of threads moving to a computer is going
 * (docs/design/fleet.md, Part 3c), for that computer's Fleet row and page:
 * "Moving 3 threads here: 1 moved, 2 waiting for their agents", then, for a
 * while after the last answer, "Moved 3 threads to Windows PC." or how many,
 * naming every one that didn't move and why.
 *
 * The words come from the batch's durable record on the computer the threads
 * leave (`moves.batchStatus`), which keeps every thread asked for: ones
 * refused when the batch was queued and ones deleted since included. It is
 * read for the batches this app knows: those its threads carry (their
 * waiting move, their move or their last outcome name the batch) and those
 * this app started (rememberMoveBatch). Each is asked again only while it
 * isn't final. Until its first answer comes, the threads' own projection
 * says it.
 *
 * @module moveBatchProgress
 */
import type {
  EnvironmentId,
  ThreadMoveBatchId,
  ThreadMoveBatchStatus,
} from "@threadlines/contracts";
import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";

import { readThreadMovesClient } from "./environments/links/threadMoves";
import { useRelativeTimeTick } from "./hooks/useRelativeTimeTick";
import { type AppState, useStore } from "./store";
import {
  countMoveBatch,
  describeMoveBatchProgress,
  isMoveBatchDone,
  type MoveBatchMiss,
  moveBatchMisses,
  threadMoveBatchState,
} from "./threadMove";
import type { ThreadShell } from "./types";

/** How long a finished batch's words stay on its computer's row and page. */
export const MOVE_BATCH_DONE_SHOWN_MS = 10 * 60_000;
/** How often a batch that isn't final is asked again. */
export const MOVE_BATCH_POLL_MS = 2_000;

type BatchThread = Pick<ThreadShell, "title" | "pendingMove" | "move" | "lastMoveOutcome">;

/** A batch this app knows of, by the computer its threads leave. */
export interface KnownMoveBatch {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly batchId: ThreadMoveBatchId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetLabel: string;
  /** When it last changed, as far as this app has seen. */
  readonly latestAt: string;
}

// ---------------------------------------------------------------------------
// Batches this app started, and what their computers last said of them
// ---------------------------------------------------------------------------

const useStartedMoveBatchesStore = create<{ readonly batches: readonly KnownMoveBatch[] }>(() => ({
  batches: [],
}));

/** A batch this app just queued (the Move threads dialog, the quit offer), as of now. */
export function rememberMoveBatch(batch: Omit<KnownMoveBatch, "latestAt">): void {
  const known: KnownMoveBatch = { ...batch, latestAt: new Date().toISOString() };
  useStartedMoveBatchesStore.setState((state) => ({
    batches: [...state.batches.filter((entry) => entry.batchId !== batch.batchId), known].slice(
      -20,
    ),
  }));
}

const batchKey = (sourceEnvironmentId: string, batchId: string) =>
  `${sourceEnvironmentId}\u0000${batchId}`;

const useMoveBatchStatusStore = create<{
  readonly byKey: Readonly<Record<string, ThreadMoveBatchStatus>>;
}>(() => ({ byKey: {} }));

/** Pollers by batch key, shared by everything that shows the batch. */
const watchers = new Map<string, { count: number; stop: () => void }>();

/**
 * Asks the batch's computer how it stands until it is final, then stops;
 * shared, so two places showing it ask once. Returns the way to stop watching.
 */
function watchMoveBatch(sourceEnvironmentId: EnvironmentId, batchId: ThreadMoveBatchId) {
  const key = batchKey(sourceEnvironmentId, batchId);
  const existing = watchers.get(key);
  if (existing !== undefined) {
    existing.count += 1;
  } else {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (useMoveBatchStatusStore.getState().byKey[key]?.final === true) return;
      const client = readThreadMovesClient(sourceEnvironmentId);
      try {
        const status = client === null ? null : await client.batchStatus({ batchId });
        if (!active) return;
        if (status !== null) {
          useMoveBatchStatusStore.setState((state) => ({
            byKey: { ...state.byKey, [key]: status },
          }));
          if (status.final) return;
        }
      } catch {
        // Not answered (offline, an older computer): asked again on the next tick.
      }
      if (active) timer = setTimeout(() => void poll(), MOVE_BATCH_POLL_MS);
    };
    void poll();
    watchers.set(key, {
      count: 1,
      stop: () => {
        active = false;
        if (timer !== null) clearTimeout(timer);
      },
    });
  }
  return () => {
    const watcher = watchers.get(key);
    if (watcher === undefined) return;
    watcher.count -= 1;
    if (watcher.count > 0) return;
    watcher.stop();
    watchers.delete(key);
  };
}

/** Browser tests start from nothing known. */
export function __resetMoveBatchProgressForTests(): void {
  for (const watcher of watchers.values()) watcher.stop();
  watchers.clear();
  useStartedMoveBatchesStore.setState({ batches: [] });
  useMoveBatchStatusStore.setState({ byKey: {} });
}

// ---------------------------------------------------------------------------
// The batches the threads carry
// ---------------------------------------------------------------------------

/** The batch a thread is in, its target and when it last changed; null for none. */
function batchOf(thread: BatchThread): {
  readonly batchId: ThreadMoveBatchId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetLabel: string;
  readonly at: string;
} | null {
  const pending = thread.pendingMove ?? null;
  if (pending !== null) {
    return pending.batchId === undefined
      ? null
      : {
          batchId: pending.batchId,
          targetEnvironmentId: pending.target.environmentId,
          targetLabel: pending.target.label,
          at: pending.requestedAt,
        };
  }
  const move = thread.move ?? null;
  if (move !== null && move.batchId !== undefined) {
    const outcome = thread.lastMoveOutcome ?? null;
    return {
      batchId: move.batchId,
      targetEnvironmentId: move.target.environmentId,
      targetLabel: move.target.label,
      at:
        move.movedAway?.movedAt ??
        (outcome?.transferId === move.transferId ? outcome.at : move.startedAt),
    };
  }
  const outcome = thread.lastMoveOutcome ?? null;
  return outcome === null || outcome.batchId === undefined
    ? null
    : {
        batchId: outcome.batchId,
        targetEnvironmentId: outcome.target.environmentId,
        targetLabel: outcome.target.label,
        at: outcome.at,
      };
}

/** What the threads themselves say of one batch: its known shape and its members' states. */
export interface ProjectedMoveBatch extends KnownMoveBatch {
  readonly members: readonly BatchThread[];
}

/** Every batch the threads on each computer carry, by batch key. */
export function collectProjectedMoveBatches(
  environments: Iterable<readonly [EnvironmentId, Iterable<BatchThread>]>,
): Map<string, ProjectedMoveBatch> {
  const byKey = new Map<string, ProjectedMoveBatch & { members: BatchThread[] }>();
  for (const [sourceEnvironmentId, threads] of environments) {
    for (const thread of threads) {
      const batch = batchOf(thread);
      if (batch === null) continue;
      const key = batchKey(sourceEnvironmentId, batch.batchId);
      const group = byKey.get(key);
      if (group === undefined) {
        byKey.set(key, {
          sourceEnvironmentId,
          batchId: batch.batchId,
          targetEnvironmentId: batch.targetEnvironmentId,
          targetLabel: batch.targetLabel,
          latestAt: batch.at,
          members: [thread],
        });
      } else {
        group.members.push(thread);
        if (batch.at > group.latestAt) byKey.set(key, { ...group, latestAt: batch.at });
      }
    }
  }
  return byKey;
}

/** Words from the threads' projection, before the batch's own record answers. */
function describeProjected(batch: ProjectedMoveBatch): {
  readonly words: string;
  readonly done: boolean;
} | null {
  const misses: MoveBatchMiss[] = [];
  const states = batch.members.flatMap((thread) => {
    const state = threadMoveBatchState(thread, batch.batchId);
    if (state === null) return [];
    if (state === "not_moved") {
      misses.push({
        title: thread.title,
        words: thread.lastMoveOutcome?.words ?? "It couldn't move.",
      });
    }
    return [state];
  });
  const counts = countMoveBatch(states);
  if (counts.total === 0) return null;
  return {
    words: describeMoveBatchProgress({ counts, targetLabel: batch.targetLabel, misses }),
    done: isMoveBatchDone(counts),
  };
}

/** Words from the batch's durable record: every member, refused and deleted ones too. */
export function describeMoveBatchStatus(
  status: ThreadMoveBatchStatus,
  targetLabel: string,
): string | null {
  const counts = countMoveBatch(status.members.map((member) => member.state));
  if (counts.total === 0) return null;
  return describeMoveBatchProgress({
    counts,
    targetLabel,
    misses: moveBatchMisses(status.members),
  });
}

/**
 * The words for the latest batch to each computer, by that computer's id.
 * One finished more than MOVE_BATCH_DONE_SHOWN_MS before `nowMs` is left out.
 */
export function describeLatestMoveBatches(input: {
  readonly projected: ReadonlyMap<string, ProjectedMoveBatch>;
  readonly started: readonly KnownMoveBatch[];
  readonly statuses: Readonly<Record<string, ThreadMoveBatchStatus>>;
  readonly nowMs: number;
}): Record<string, string> {
  const latestByTarget = latestMoveBatchByTarget(input.projected, input.started);
  const words: Record<string, string> = {};
  for (const [targetEnvironmentId, batch] of latestByTarget) {
    const key = batchKey(batch.sourceEnvironmentId, batch.batchId);
    const status = input.statuses[key];
    const projected = input.projected.get(key);
    let said: string | null = null;
    let done = false;
    let latestAt = batch.latestAt;
    if (status !== undefined) {
      said = describeMoveBatchStatus(status, status.target.label);
      done = status.final;
      if (status.createdAt > latestAt) latestAt = status.createdAt;
    } else if (projected !== undefined) {
      const fromThreads = describeProjected(projected);
      said = fromThreads?.words ?? null;
      done = fromThreads?.done ?? false;
    }
    if (said === null) continue;
    if (done && Date.parse(latestAt) < input.nowMs - MOVE_BATCH_DONE_SHOWN_MS) continue;
    words[targetEnvironmentId] = said;
  }
  return words;
}

/** The latest batch this app knows to each computer. */
function latestMoveBatchByTarget(
  projected: ReadonlyMap<string, ProjectedMoveBatch>,
  started: readonly KnownMoveBatch[],
): Map<string, KnownMoveBatch> {
  const latest = new Map<string, KnownMoveBatch>();
  const consider = (batch: KnownMoveBatch) => {
    const current = latest.get(batch.targetEnvironmentId);
    if (current === undefined || batch.latestAt > current.latestAt) {
      latest.set(batch.targetEnvironmentId, batch);
    }
  };
  for (const batch of projected.values()) consider(batch);
  for (const batch of started) {
    const seen = projected.get(batchKey(batch.sourceEnvironmentId, batch.batchId));
    consider(seen !== undefined && seen.latestAt > batch.latestAt ? seen : batch);
  }
  return latest;
}

function selectProjectedMoveBatches(state: AppState): Map<string, ProjectedMoveBatch> {
  return collectProjectedMoveBatches(
    Object.entries(state.environmentStateById).map(
      ([environmentId, environment]) =>
        [environmentId as EnvironmentId, Object.values(environment.threadShellById)] as const,
    ),
  );
}

/**
 * describeLatestMoveBatches over every computer this app hears, kept current:
 * each shown batch that isn't final is asked again until it is. Mount it only
 * where it shows (Fleet): it reads every thread on each store change.
 */
export function useLatestMoveBatches(): Readonly<Record<string, string>> {
  // A minute is fine enough for a finished batch's words to go away.
  const nowMs = useRelativeTimeTick(60_000);
  // The batches, as a string: equal answers don't render again.
  const projectedKey = useStore(
    useCallback((state: AppState) => {
      const batches = [...selectProjectedMoveBatches(state).values()];
      return JSON.stringify(
        batches.map((batch) => ({
          ...batch,
          members: batch.members.map((thread) => ({
            title: thread.title,
            pendingMove: thread.pendingMove ?? null,
            move: thread.move ?? null,
            lastMoveOutcome: thread.lastMoveOutcome ?? null,
          })),
        })),
      );
    }, []),
  );
  const projected = useMemo(() => {
    const batches = JSON.parse(projectedKey) as ProjectedMoveBatch[];
    return new Map(
      batches.map((batch) => [batchKey(batch.sourceEnvironmentId, batch.batchId), batch] as const),
    );
  }, [projectedKey]);
  const started = useStartedMoveBatchesStore((state) => state.batches);
  const statuses = useMoveBatchStatusStore((state) => state.byKey);

  // The latest batch to each computer, as one string, so the watchers change
  // only when the batches do.
  const watchedKey = useMemo(
    () =>
      JSON.stringify(
        [...latestMoveBatchByTarget(projected, started).values()].map((batch) => [
          batch.sourceEnvironmentId,
          batch.batchId,
        ]),
      ),
    [projected, started],
  );
  useEffect(() => {
    const watched = JSON.parse(watchedKey) as Array<[EnvironmentId, ThreadMoveBatchId]>;
    const stops = watched.map(([sourceEnvironmentId, batchId]) =>
      watchMoveBatch(sourceEnvironmentId, batchId),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [watchedKey]);

  return useMemo(
    () => describeLatestMoveBatches({ projected, started, statuses, nowMs }),
    [nowMs, projected, started, statuses],
  );
}
