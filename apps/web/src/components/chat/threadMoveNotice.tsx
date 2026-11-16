/**
 * The composer notice for a thread moving, or moved, to a linked computer
 * (docs/design/fleet.md, Part 3), on the computer it leaves.
 *
 * From the moment a move starts the thread is frozen here, so this notice is
 * the only one the dock shows: how far the move got, with Cancel, until the
 * other computer takes it; then where it went, with Open when this app has
 * it there. A move whose link to the other computer is gone can neither
 * finish nor stop, and offers a way to keep working here instead: a new
 * thread forked from this one.
 *
 * Before that, a move can wait for the thread to be free (Part 3b): its
 * notice says when it goes, or what holds it, with Cancel (and Try again
 * when held). One that ended without starting says why ("Didn't move: …")
 * until the user dismisses it.
 *
 * @module threadMoveNotice
 */
import {
  type EnvironmentId,
  type OrchestrationThreadMove,
  type ThreadId,
  ThreadMoveNotStartedPayload,
  type ThreadMoveRequestId,
  type ThreadPendingMove,
} from "@threadlines/contracts";
import { scopeThreadRef } from "@threadlines/client-runtime";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useCallback, useMemo, useState } from "react";

import { describeComputerLinkFailure } from "../../environments/links/computerLinks";
import {
  requireThreadMovesClient,
  useLiveOutboundLinks,
} from "../../environments/links/threadMoves";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useStore } from "../../store";
import {
  describePendingMove,
  describeThreadMoveProgress,
  isThreadMoveStalled,
  THREAD_MOVE_NOT_STARTED_ACTIVITY_KIND,
} from "../../threadMove";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { Thread } from "../../types";
import { Button } from "../ui/button";
import { failureNotice, toastManager } from "../ui/toast";
import type { ComposerNotice } from "./composerNotices";

export interface ThreadMoveNoticeActions {
  /** Asks to stop the move; absent once that was asked. */
  readonly onCancel: () => void;
  readonly cancelling: boolean;
  /** Opens the thread on the computer it moved to; null when this app doesn't have it. */
  readonly onOpen: (() => void) | null;
  /** Starts a new thread here from this one: the way on when a move can't go on. */
  readonly onContinueHere: () => void;
}

export function buildThreadMoveNotice(input: {
  readonly move: OrchestrationThreadMove;
  /** The link to the other computer is gone or can't reach it (isThreadMoveStalled). */
  readonly stalled: boolean;
  readonly actions: ThreadMoveNoticeActions;
}): ComposerNotice {
  const { move, stalled, actions } = input;
  const label = move.target.label;
  if (move.movedAway) {
    return {
      id: `thread-moved:${move.transferId}`,
      severity: "info",
      lead: `Moved to ${label}.`,
      ...(actions.onOpen === null ? { detail: `Connect to ${label} to open it.` } : {}),
      ...(actions.onOpen !== null
        ? {
            actions: (
              <Button size="xs" onClick={actions.onOpen} aria-label={`Open it on ${label}`}>
                Open
              </Button>
            ),
          }
        : {}),
    };
  }
  if (stalled) {
    return {
      id: `thread-move-stalled:${move.transferId}`,
      severity: "warning",
      lead: `Can't reach ${label}.`,
      detail: "The move can't finish or stop until the two computers reconnect.",
      actions: (
        <Button size="xs" onClick={actions.onContinueHere}>
          Continue here as a new thread
        </Button>
      ),
    };
  }
  return {
    id: `thread-moving:${move.transferId}`,
    severity: "info",
    lead: describeThreadMoveProgress(move),
    ...(move.cancelRequested
      ? {}
      : {
          actions: (
            <Button
              size="xs"
              variant="outline"
              disabled={actions.cancelling}
              onClick={actions.onCancel}
              aria-label="Cancel the move"
            >
              Cancel
            </Button>
          ),
        }),
  };
}

/** Whether this app reaches `environmentId` right now. */
function useConnectedNow(environmentId: EnvironmentId | null): boolean {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedConnected = useSavedEnvironmentRuntimeStore((state) =>
    environmentId === null ? false : state.byId[environmentId]?.connectionState === "connected",
  );
  return environmentId !== null && (primaryEnvironmentId === environmentId || savedConnected);
}

/**
 * buildThreadMoveNotice for the open thread, with its actions: Cancel goes to
 * the thread's own computer, Open to the thread on the other one.
 */
export function useThreadMoveNotice(input: {
  readonly thread: Pick<Thread, "id" | "environmentId" | "move"> | undefined;
  readonly computerLabel: string;
  readonly onContinueHere: () => void;
}): ComposerNotice | null {
  const { thread, computerLabel, onContinueHere } = input;
  const move = thread?.move ?? null;
  const navigate = useNavigate();
  const outbound = useLiveOutboundLinks(thread?.environmentId ?? null);
  const [cancellingThreadId, setCancellingThreadId] = useState<ThreadId | null>(null);
  const targetEnvironmentId = move?.target.environmentId ?? null;
  const movedThreadId = move?.movedAway?.threadId ?? null;
  const movedThreadRef = useMemo(
    () =>
      targetEnvironmentId !== null && movedThreadId !== null
        ? scopeThreadRef(targetEnvironmentId, movedThreadId)
        : null,
    [movedThreadId, targetEnvironmentId],
  );
  const targetConnected = useConnectedNow(movedThreadRef?.environmentId ?? null);
  const appHasMovedThread = useStore((state) =>
    movedThreadRef === null
      ? false
      : state.environmentStateById[movedThreadRef.environmentId]?.threadShellById[
          movedThreadRef.threadId
        ] !== undefined,
  );
  const canOpen = movedThreadRef !== null && targetConnected && appHasMovedThread;

  const onCancel = useCallback(() => {
    if (!thread) return;
    setCancellingThreadId(thread.id);
    void (async () => {
      try {
        await requireThreadMovesClient(thread.environmentId, computerLabel).cancel({
          threadId: thread.id,
        });
      } catch (error) {
        toastManager.add(
          failureNotice({
            title: "Couldn't stop the move",
            reason: describeComputerLinkFailure(error, `${computerLabel} didn't answer.`),
          }),
        );
      } finally {
        setCancellingThreadId((current) => (current === thread.id ? null : current));
      }
    })();
  }, [computerLabel, thread]);

  const onOpen = useCallback(() => {
    if (movedThreadRef === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(movedThreadRef),
    });
  }, [movedThreadRef, navigate]);

  const stalled = isThreadMoveStalled({ move, outbound });
  const cancelling = thread !== undefined && cancellingThreadId === thread.id;
  return useMemo(
    () =>
      move === null
        ? null
        : buildThreadMoveNotice({
            move,
            stalled,
            actions: {
              onCancel,
              cancelling,
              onOpen: canOpen ? onOpen : null,
              onContinueHere,
            },
          }),
    [canOpen, cancelling, move, onCancel, onContinueHere, onOpen, stalled],
  );
}

export interface PendingMoveNoticeActions {
  /** Cancels the move the notice shows (its own request id, never a newer one). */
  readonly onCancel: () => void;
  readonly cancelling: boolean;
  /** Asks the server to try a held move again now. */
  readonly onRetry: () => void;
  readonly retrying: boolean;
}

/** The notice for a move that waits for the thread to be free (Part 3b). */
export function buildPendingMoveNotice(input: {
  readonly pendingMove: ThreadPendingMove;
  readonly actions: PendingMoveNoticeActions;
}): ComposerNotice {
  const { pendingMove, actions } = input;
  const words = describePendingMove(pendingMove);
  return {
    id: `thread-move-queued:${pendingMove.requestId}`,
    severity: words.severity,
    lead: words.lead,
    // On a phone the words get the row's whole width; they run long.
    wrapActions: true,
    actions: (
      <>
        {words.retry ? (
          <Button
            size="xs"
            variant="outline"
            disabled={actions.retrying || actions.cancelling}
            onClick={actions.onRetry}
          >
            Try again
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          disabled={actions.cancelling}
          onClick={actions.onCancel}
          aria-label="Cancel the move"
        >
          Cancel
        </Button>
      </>
    ),
  };
}

/** A request this app is sending for a thread's waiting move, and which. */
interface PendingMoveCall {
  readonly kind: "cancel" | "retry";
  readonly threadId: ThreadId;
  readonly requestId: ThreadMoveRequestId;
}

/**
 * buildPendingMoveNotice for the open thread, with its actions: Cancel and
 * Try again go to the thread's own computer, naming the request shown.
 */
export function usePendingMoveNotice(input: {
  readonly thread: Pick<Thread, "id" | "environmentId" | "pendingMove"> | undefined;
  readonly computerLabel: string;
}): ComposerNotice | null {
  const { thread, computerLabel } = input;
  const pendingMove = thread?.pendingMove ?? null;
  const environmentId = thread?.environmentId ?? null;
  const threadId = thread?.id ?? null;
  const [call, setCall] = useState<PendingMoveCall | null>(null);

  const send = useCallback(
    (kind: PendingMoveCall["kind"], requestId: ThreadMoveRequestId) => {
      if (environmentId === null || threadId === null) return;
      const current = { kind, threadId, requestId };
      setCall(current);
      void (async () => {
        try {
          const client = requireThreadMovesClient(environmentId, computerLabel);
          await (kind === "cancel"
            ? client.unqueue({ threadId, requestId })
            : client.retry({ threadId, requestId }));
        } catch (error) {
          toastManager.add(
            failureNotice({
              title: kind === "cancel" ? "Couldn't cancel the move" : "Couldn't try the move again",
              reason: describeComputerLinkFailure(error, `${computerLabel} didn't answer.`),
            }),
          );
        } finally {
          setCall((latest) => (latest === current ? null : latest));
        }
      })();
    },
    [computerLabel, environmentId, threadId],
  );

  const requestId = pendingMove?.requestId ?? null;
  const busyWith = (kind: PendingMoveCall["kind"]) =>
    call !== null &&
    call.kind === kind &&
    call.threadId === threadId &&
    call.requestId === requestId;
  const cancelling = busyWith("cancel");
  const retrying = busyWith("retry");
  return useMemo(
    () =>
      pendingMove === null
        ? null
        : buildPendingMoveNotice({
            pendingMove,
            actions: {
              onCancel: () => send("cancel", pendingMove.requestId),
              cancelling,
              onRetry: () => send("retry", pendingMove.requestId),
              retrying,
            },
          }),
    [cancelling, pendingMove, retrying, send],
  );
}

const isMoveNotStartedPayload = Schema.is(ThreadMoveNotStartedPayload);

const MOVE_NOT_STARTED_DISMISSALS_STORAGE_KEY = "threadlines:move-not-started-dismissals:v1";
const MoveNotStartedDismissalsSchema = Schema.Struct({ keys: Schema.Array(Schema.String) });
/** Enough to outlast any notice still on screen; older keys fall off the front. */
const MAX_MOVE_NOT_STARTED_DISMISSALS = 200;

/**
 * The thread's last queued move that ended without starting ("Didn't move:
 * <why>"), until dismissed on this device. Gone while another move waits or
 * runs, which says more.
 */
export function useMoveNotStartedNotice(input: {
  readonly thread:
    | Pick<Thread, "id" | "environmentId" | "activities" | "move" | "pendingMove">
    | undefined;
}): ComposerNotice | null {
  const { thread } = input;
  const [dismissals, setDismissals] = useLocalStorage(
    MOVE_NOT_STARTED_DISMISSALS_STORAGE_KEY,
    { keys: [] },
    MoveNotStartedDismissalsSchema,
  );
  const busy = Boolean(thread?.move || thread?.pendingMove);
  const activities = thread?.activities;
  const latest = useMemo(() => {
    if (!activities) return null;
    for (let index = activities.length - 1; index >= 0; index -= 1) {
      const activity = activities[index];
      if (activity?.kind !== THREAD_MOVE_NOT_STARTED_ACTIVITY_KIND) continue;
      return isMoveNotStartedPayload(activity.payload) ? activity.payload : null;
    }
    return null;
  }, [activities]);
  const dismissalKey =
    thread && latest ? `${thread.environmentId}:${thread.id}:${latest.requestId}` : null;
  const dismissed = dismissalKey !== null && dismissals.keys.includes(dismissalKey);
  const dismiss = useCallback(() => {
    if (dismissalKey === null) return;
    setDismissals((current) =>
      current.keys.includes(dismissalKey)
        ? current
        : { keys: [...current.keys, dismissalKey].slice(-MAX_MOVE_NOT_STARTED_DISMISSALS) },
    );
  }, [dismissalKey, setDismissals]);
  return useMemo<ComposerNotice | null>(
    () =>
      latest === null || busy || dismissed
        ? null
        : {
            id: `thread-move-not-started:${latest.requestId}`,
            severity: "warning",
            lead: "Didn't move:",
            detail: latest.words,
            dismissLabel: `Dismiss why it didn't move to ${latest.targetLabel}`,
            onDismiss: dismiss,
          },
    [busy, dismiss, dismissed, latest],
  );
}
