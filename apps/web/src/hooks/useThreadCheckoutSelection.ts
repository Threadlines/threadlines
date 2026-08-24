import type { ScopedThreadRef } from "@threadlines/contracts";
import { useCallback } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { newCommandId } from "../lib/utils";
import { useStore } from "../store";
import type { ThreadSession } from "../types";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

interface SelectedThreadCheckout {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly effectiveCwd: string | null;
  readonly session: ThreadSession | null;
}

let nextCheckoutDispatchId = 0;
const latestCheckoutDispatchByThread = new Map<string, number>();

function checkoutDispatchKey(threadRef: ScopedThreadRef): string {
  return `${threadRef.environmentId}\0${threadRef.threadId}`;
}

/**
 * One durable checkout-selection action shared by the composer and Source.
 * It owns connection checks, optimistic state, stale-safe rollback, and the
 * explicit-selection command that overrides inferred subagent following.
 */
export function useThreadCheckoutSelection(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly thread: SelectedThreadCheckout | null;
  readonly onBranchOverrideChange?: ((branch: string | null) => void) | undefined;
}) {
  const { threadRef, thread, onBranchOverrideChange } = input;
  const selectThreadCheckout = useStore((store) => store.selectThreadCheckout);
  const restoreThreadCheckout = useStore((store) => store.restoreThreadCheckout);

  return useCallback(
    (branch: string | null, worktreePath: string | null): boolean => {
      if (!threadRef || !thread) {
        return false;
      }
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Couldn't move the thread",
            description: "Not connected to the environment. Try again once it reconnects.",
          }),
        );
        return false;
      }

      const snapshot = {
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        effectiveCwd: thread.effectiveCwd,
        session: thread.session,
      };
      nextCheckoutDispatchId += 1;
      const dispatchId = nextCheckoutDispatchId;
      const dispatchKey = checkoutDispatchKey(threadRef);
      latestCheckoutDispatchByThread.set(dispatchKey, dispatchId);
      void api.orchestration
        .dispatchCommand({
          type: "thread.checkout.select",
          commandId: newCommandId(),
          threadId: threadRef.threadId,
          branch,
          worktreePath,
        })
        .then(
          () => {
            if (latestCheckoutDispatchByThread.get(dispatchKey) === dispatchId) {
              latestCheckoutDispatchByThread.delete(dispatchKey);
            }
          },
          () => {
            // The composer and Source can both issue this action. Only the
            // newest selection across every mounted surface may roll back.
            if (latestCheckoutDispatchByThread.get(dispatchKey) !== dispatchId) {
              return;
            }
            latestCheckoutDispatchByThread.delete(dispatchKey);
            restoreThreadCheckout(threadRef, snapshot);
            onBranchOverrideChange?.(snapshot.branch);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Couldn't move the thread",
                description: "The checkout switch didn't reach the server. Try again.",
              }),
            );
          },
        );

      onBranchOverrideChange?.(branch);
      selectThreadCheckout(threadRef, branch, worktreePath);
      return true;
    },
    [onBranchOverrideChange, restoreThreadCheckout, selectThreadCheckout, thread, threadRef],
  );
}
