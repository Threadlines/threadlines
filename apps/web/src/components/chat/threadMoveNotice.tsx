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
 * @module threadMoveNotice
 */
import type { EnvironmentId, OrchestrationThreadMove, ThreadId } from "@threadlines/contracts";
import { scopeThreadRef } from "@threadlines/client-runtime";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { describeComputerLinkFailure } from "../../environments/links/computerLinks";
import {
  requireThreadMovesClient,
  useLiveOutboundLinks,
} from "../../environments/links/threadMoves";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime";
import { useStore } from "../../store";
import { describeThreadMoveProgress, isThreadMoveStalled } from "../../threadMove";
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
