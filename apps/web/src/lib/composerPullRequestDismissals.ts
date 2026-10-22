/**
 * Which pull request rows the user has closed above a thread's composer.
 *
 * The thread holds the answer on the server (`dismissedPullRequests`), so a
 * closed row stays closed after a restart and on every device, and the Pull
 * request tab is the way to bring one back. This module is the one place that
 * writes it.
 *
 * A click is held here until the thread's shell has caught up with it, so the
 * row moves the moment it is clicked and never flickers back while the
 * command is on its way. Caught up means a shell update for the thread, or a
 * whole shell snapshot, at or past the sequence the server gave the command:
 * the shell stream is ordered, so from then on the server's list speaks. The
 * environment service reports each one (`settleComposerPullRequestDismissals`).
 * A write the server refuses drops its hold, and the row shows what the
 * server says. A row's writes go out one at a time, so the server takes them
 * in the order they were clicked even when the connection retries one.
 *
 * @module composerPullRequestDismissals
 */
import type {
  DispatchResult,
  EnvironmentId,
  ScopedThreadRef,
  ThreadId,
} from "@threadlines/contracts";
import { create } from "zustand";

import { setThreadPullRequestDismissed } from "./threadPullRequestCommands";

interface DismissalHold {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly dismissed: boolean;
  /** Which click placed it, so only that click's answer settles it. */
  readonly clickId: number;
  /** The sequence the server gave the command; null until it answers. */
  readonly sequence: number | null;
  /** The newest shell sequence seen for the thread while the command was out. */
  readonly seenSequence: number;
}

export type ComposerPullRequestDismissalHolds = ReadonlyMap<string, DismissalHold>;

const NO_HOLDS: ComposerPullRequestDismissalHolds = new Map();

let nextClickId = 0;

const useDismissalHoldStore = create<{ readonly holds: ComposerPullRequestDismissalHolds }>(() => ({
  holds: NO_HOLDS,
}));

function holdKey(threadRef: ScopedThreadRef, pullRequestNumber: number): string {
  return `${threadRef.environmentId}:${threadRef.threadId}#${pullRequestNumber}`;
}

/** The last write queued for each row; settles either way, never rejects. */
const writeQueueTails = new Map<string, Promise<void>>();

/** Sends `write` once the row's earlier writes have been answered. */
function queueWrite(key: string, write: () => Promise<DispatchResult>): Promise<DispatchResult> {
  const result = (writeQueueTails.get(key) ?? Promise.resolve()).then(write);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  writeQueueTails.set(key, tail);
  void tail.then(() => {
    if (writeQueueTails.get(key) === tail) {
      writeQueueTails.delete(key);
    }
  });
  return result;
}

/** Rewrites the holds `change` touches; returns the same map when none. */
function updateHolds(
  change: (hold: DismissalHold) => DismissalHold | null,
  keys?: ReadonlyArray<string>,
): void {
  useDismissalHoldStore.setState(({ holds }) => {
    let next: Map<string, DismissalHold> | null = null;
    for (const key of keys ?? [...holds.keys()]) {
      const hold = holds.get(key);
      if (hold === undefined) continue;
      const updated = change(hold);
      if (updated === hold) continue;
      next ??= new Map(holds);
      if (updated === null) {
        next.delete(key);
      } else {
        next.set(key, updated);
      }
    }
    if (next === null) {
      return { holds };
    }
    return { holds: next.size === 0 ? NO_HOLDS : next };
  });
}

/** The clicks still waiting on the server, for `isComposerPullRequestDismissed`. */
export function useComposerPullRequestDismissalHolds(): ComposerPullRequestDismissalHolds {
  return useDismissalHoldStore((store) => store.holds);
}

/** The same, read once outside React. */
export function readComposerPullRequestDismissalHolds(): ComposerPullRequestDismissalHolds {
  return useDismissalHoldStore.getState().holds;
}

/** Whether a pull request's row is closed: a click still held, else the thread. */
export function isComposerPullRequestDismissed(input: {
  readonly holds: ComposerPullRequestDismissalHolds;
  readonly threadRef: ScopedThreadRef;
  readonly pullRequestNumber: number;
  readonly serverDismissed: readonly number[] | undefined;
}): boolean {
  const hold = input.holds.get(holdKey(input.threadRef, input.pullRequestNumber));
  return hold?.dismissed ?? input.serverDismissed?.includes(input.pullRequestNumber) ?? false;
}

/** Close a pull request's row above the composer, or bring it back. */
export function setComposerPullRequestDismissed(
  threadRef: ScopedThreadRef,
  pullRequestNumber: number,
  dismissed: boolean,
): void {
  const key = holdKey(threadRef, pullRequestNumber);
  nextClickId += 1;
  const clickId = nextClickId;
  const hold: DismissalHold = {
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    dismissed,
    clickId,
    sequence: null,
    seenSequence: -1,
  };
  useDismissalHoldStore.setState(({ holds }) => ({ holds: new Map(holds).set(key, hold) }));
  // A later click replaces the hold, so an answer to this one leaves it be.
  void queueWrite(key, () =>
    setThreadPullRequestDismissed(threadRef, pullRequestNumber, dismissed),
  ).then(
    ({ sequence }) =>
      updateHolds(
        (current) => {
          if (current.clickId !== clickId) return current;
          // The shell already carried the write while the answer was out.
          if (current.seenSequence >= sequence) return null;
          return { ...current, sequence };
        },
        [key],
      ),
    () => updateHolds((current) => (current.clickId === clickId ? null : current), [key]),
  );
}

/**
 * Called by the environment service once it has applied shell state: one
 * thread's update (`threadId`), a whole snapshot (no `threadId`), or a thread
 * leaving the shell (`removed`). Holds the server has answered for let go.
 */
export function settleComposerPullRequestDismissals(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly sequence: number;
  readonly removed?: boolean;
}): void {
  if (useDismissalHoldStore.getState().holds.size === 0) {
    return;
  }
  updateHolds((hold) => {
    if (
      hold.environmentId !== input.environmentId ||
      (input.threadId !== undefined && hold.threadId !== input.threadId)
    ) {
      return hold;
    }
    if (input.removed) {
      return null;
    }
    if (hold.sequence === null) {
      return input.sequence > hold.seenSequence ? { ...hold, seenSequence: input.sequence } : hold;
    }
    return input.sequence >= hold.sequence ? null : hold;
  });
}

export function __resetComposerPullRequestDismissalsForTests(): void {
  useDismissalHoldStore.setState({ holds: NO_HOLDS });
  writeQueueTails.clear();
}
