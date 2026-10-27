/**
 * Sends on their way, by scoped thread key: what a thread shows from the
 * moment a message goes out until the server's state answers it ("Sending",
 * "Preparing a new worktree from main", the timer, and for a new thread the
 * model and agent its first message went out with). Kept out of the chat
 * view, so a send still shows when the view is rebuilt (a new thread's draft
 * screen and its thread screen are different views) or the user comes back
 * to the thread, and a Retry clicked from anywhere shows on its own thread.
 *
 * A send ends when the thread's state shows the server's answer (checked by
 * whichever view shows the thread), when it fails, or, once the server has
 * taken it, when no view shows the thread any more: from there the server's
 * own state says what the thread is doing. Each change names its send, so a
 * late answer to an older send never touches a newer one.
 *
 * @module localDispatch
 */
import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import type {
  ApprovalRequestId,
  EnvironmentId,
  ModelSelection,
  ScopedThreadRef,
  ThreadId,
  ThreadParticipantId,
} from "@threadlines/contracts";
import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";

import { refreshThreadDetailSubscription } from "../../environments/runtime/service";
import { randomUUID } from "../../lib/utils";
import type { SessionPhase, Thread } from "../../types";
import {
  createLocalDispatchSnapshot,
  hasServerAcknowledgedLocalDispatch,
  type LocalDispatchSnapshot,
} from "../ChatView.logic";

/** How long after the server took a send to look again, if the thread still shows nothing of it. */
const RECONCILIATION_DELAY_MS = 2_000;

/**
 * A new thread's first message. Until the server has the thread, the chat
 * names the agent at work by it, whatever the composer is switched to
 * meanwhile.
 */
export interface FirstSend {
  /** The thread's own model, as the message creates the thread with it. */
  readonly modelSelection: ModelSelection;
  /** The agent the message went to; null for the thread's own. */
  readonly participantId: ThreadParticipantId | null;
}

export interface LocalDispatch {
  readonly threadRef: ScopedThreadRef;
  /** Which send this is. */
  readonly sendId: string;
  /** The thread as it was before the send went out: the server's answer changes it. */
  readonly snapshot: LocalDispatchSnapshot;
  /** When the server took it (ms since epoch); null while the request is out. */
  readonly acceptedAt: number | null;
  readonly firstSend: FirstSend | null;
}

interface LocalDispatchState {
  readonly byThreadKey: Readonly<Record<string, LocalDispatch>>;
  /**
   * Starts a send on its thread. Starting the same send again (its second
   * start, just before the request) keeps its timer; another send replaces it.
   */
  readonly begin: (start: {
    readonly threadRef: ScopedThreadRef;
    readonly sendId: string;
    readonly snapshot: LocalDispatchSnapshot;
    readonly firstSend: FirstSend | null;
  }) => void;
  readonly markAccepted: (threadRef: ScopedThreadRef, sendId: string) => void;
  readonly clear: (threadRef: ScopedThreadRef, sendId: string) => void;
  /** No view shows the thread: a send the server has taken is its to show now. */
  readonly release: (threadRef: ScopedThreadRef) => void;
}

const withoutKey = (byThreadKey: Readonly<Record<string, LocalDispatch>>, threadKey: string) => {
  const { [threadKey]: _removed, ...rest } = byThreadKey;
  return rest;
};

export const useLocalDispatchStore = create<LocalDispatchState>((set) => ({
  byThreadKey: {},
  begin: ({ threadRef, sendId, snapshot, firstSend }) =>
    set((state) => {
      const threadKey = scopedThreadKey(threadRef);
      const existing = state.byThreadKey[threadKey];
      if (existing?.sendId === sendId) {
        if (
          existing.acceptedAt === null &&
          existing.snapshot.worktreeBase === snapshot.worktreeBase
        ) {
          return state;
        }
        return {
          byThreadKey: {
            ...state.byThreadKey,
            [threadKey]: {
              ...existing,
              snapshot: { ...existing.snapshot, worktreeBase: snapshot.worktreeBase },
              acceptedAt: null,
            },
          },
        };
      }
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: {
            threadRef,
            sendId,
            snapshot: { ...snapshot, startedAt: new Date().toISOString() },
            acceptedAt: null,
            firstSend,
          },
        },
      };
    }),
  markAccepted: (threadRef, sendId) =>
    set((state) => {
      const threadKey = scopedThreadKey(threadRef);
      const existing = state.byThreadKey[threadKey];
      if (existing?.sendId !== sendId) return state;
      return {
        byThreadKey: { ...state.byThreadKey, [threadKey]: { ...existing, acceptedAt: Date.now() } },
      };
    }),
  clear: (threadRef, sendId) =>
    set((state) => {
      const threadKey = scopedThreadKey(threadRef);
      if (state.byThreadKey[threadKey]?.sendId !== sendId) return state;
      return { byThreadKey: withoutKey(state.byThreadKey, threadKey) };
    }),
  release: (threadRef) =>
    set((state) => {
      const threadKey = scopedThreadKey(threadRef);
      const existing = state.byThreadKey[threadKey];
      if (!existing || existing.acceptedAt === null) return state;
      return { byThreadKey: withoutKey(state.byThreadKey, threadKey) };
    }),
}));

/** Views showing each thread, by scoped thread key. */
const viewsByThreadKey = new Map<string, number>();

/**
 * Counts a view showing the thread; the returned function stops counting it.
 * When the last view goes, the thread's send is released, unless a view shows
 * it again first: a route change rebuilding the view, or React's development
 * remount, is not leaving.
 */
function watchThread(threadRef: ScopedThreadRef): () => void {
  const threadKey = scopedThreadKey(threadRef);
  viewsByThreadKey.set(threadKey, (viewsByThreadKey.get(threadKey) ?? 0) + 1);
  return () => {
    const views = (viewsByThreadKey.get(threadKey) ?? 1) - 1;
    if (views > 0) {
      viewsByThreadKey.set(threadKey, views);
      return;
    }
    viewsByThreadKey.delete(threadKey);
    queueMicrotask(() => {
      if (!viewsByThreadKey.has(threadKey)) {
        useLocalDispatchStore.getState().release(threadRef);
      }
    });
  };
}

/** A new thread's first message on its way, if one is. */
export function useFirstSend(threadKey: string): FirstSend | null {
  return useLocalDispatchStore((state) => state.byThreadKey[threadKey]?.firstSend ?? null);
}

/**
 * The send on its way on the thread on screen, and the chat view's ways to
 * start and end one there. It checks the thread's state for the server's
 * answer, and counts this view as one showing the thread.
 */
export function useLocalDispatchState(input: {
  environmentId: EnvironmentId | undefined;
  threadId: ThreadId | undefined;
  activeThread: Thread | undefined;
  activeLatestTurn: Thread["latestTurn"] | null;
  phase: SessionPhase;
  activePendingApproval: ApprovalRequestId | null;
  activePendingUserInput: ApprovalRequestId | null;
  threadError: string | null | undefined;
}) {
  const { environmentId, threadId, activeThread } = input;
  const threadRef = useMemo<ScopedThreadRef | null>(
    () => (environmentId && threadId ? scopeThreadRef(environmentId, threadId) : null),
    [environmentId, threadId],
  );
  const entry = useLocalDispatchStore((state) =>
    threadRef === null ? null : (state.byThreadKey[scopedThreadKey(threadRef)] ?? null),
  );
  const localDispatch = entry?.snapshot ?? null;

  /** Starts a send on the thread on screen; returns its id, for ending it. */
  const beginLocalDispatch = useCallback((): string | null => {
    if (threadRef === null) return null;
    const sendId = randomUUID();
    useLocalDispatchStore.getState().begin({
      threadRef,
      sendId,
      snapshot: createLocalDispatchSnapshot(activeThread),
      firstSend: null,
    });
    return sendId;
  }, [activeThread, threadRef]);

  const resetLocalDispatch = useCallback(
    (sendId: string | null) => {
      if (threadRef !== null && sendId !== null) {
        useLocalDispatchStore.getState().clear(threadRef, sendId);
      }
    },
    [threadRef],
  );

  const markLocalDispatchAccepted = useCallback(
    (acceptedRef: ScopedThreadRef, sendId: string | null) => {
      if (sendId !== null) useLocalDispatchStore.getState().markAccepted(acceptedRef, sendId);
    },
    [],
  );

  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: input.phase,
        latestTurn: input.activeLatestTurn,
        session: activeThread?.session ?? null,
        hasPendingApproval: input.activePendingApproval !== null,
        hasPendingUserInput: input.activePendingUserInput !== null,
        threadError: input.threadError,
      }),
    [
      activeThread?.session,
      input.activeLatestTurn,
      input.activePendingApproval,
      input.activePendingUserInput,
      input.phase,
      input.threadError,
      localDispatch,
    ],
  );

  const sendId = entry?.sendId ?? null;
  useEffect(() => {
    if (!serverAcknowledgedLocalDispatch || threadRef === null || sendId === null) {
      return;
    }
    useLocalDispatchStore.getState().clear(threadRef, sendId);
  }, [sendId, serverAcknowledgedLocalDispatch, threadRef]);

  const acceptedAt = entry?.acceptedAt ?? null;
  useEffect(() => {
    if (threadRef === null || acceptedAt === null || serverAcknowledgedLocalDispatch) {
      return;
    }
    const timeoutId = globalThis.setTimeout(() => {
      refreshThreadDetailSubscription(threadRef.environmentId, threadRef.threadId);
    }, RECONCILIATION_DELAY_MS);
    return () => {
      globalThis.clearTimeout(timeoutId);
    };
  }, [acceptedAt, serverAcknowledgedLocalDispatch, threadRef]);

  useEffect(() => (threadRef === null ? undefined : watchThread(threadRef)), [threadRef]);

  return {
    beginLocalDispatch,
    markLocalDispatchAccepted,
    resetLocalDispatch,
    localDispatchStartedAt: localDispatch?.startedAt ?? null,
    /** The branch a new worktree is being cut from for the send, if one is. */
    preparingWorktreeFrom: localDispatch?.worktreeBase ?? null,
    isSendBusy: localDispatch !== null && !serverAcknowledgedLocalDispatch,
  };
}
