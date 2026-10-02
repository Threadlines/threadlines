import type { ScopedThreadRef } from "@threadlines/contracts";

import {
  selectPendingBrowserApprovals,
  useBrowserPanelStore,
  type PendingBrowserApproval,
} from "../../browserPanelStore";

/**
 * An agent's browser request, paused on a question to the user.
 *
 * The question itself is queue state in the panel store, where the approval
 * bar reads it. What waits on the answer is a promise, which has no business
 * in a store, so it lives here keyed by the question's id: the bar answers
 * through {@link answerBrowserApproval}, and the request that asked picks the
 * answer up and carries on -- loading the page itself, so the bar must not.
 */

export type BrowserApprovalDecision = "allowSite" | "allowAllSites" | "decline";

const waiters = new Map<string, (decision: BrowserApprovalDecision) => void>();
let sequence = 0;

/**
 * Puts a question in front of the user and waits for the answer.
 *
 * Settles with the decision, or rejects when `signal` aborts (the request was
 * cancelled or its browser went away) -- and either way the question leaves
 * the queue, so nobody is asked about a request that is no longer waiting.
 */
export function waitForBrowserApproval(
  threadRef: ScopedThreadRef,
  approval: Omit<PendingBrowserApproval, "id" | "waiting">,
  signal: AbortSignal | undefined,
  /** Told the question as asked, so another surface can offer to answer it. */
  onAsked?: (asked: PendingBrowserApproval) => void,
): Promise<BrowserApprovalDecision> {
  sequence += 1;
  const id = `approval-${sequence}`;
  const store = useBrowserPanelStore.getState();
  return new Promise<BrowserApprovalDecision>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("The browser request stopped waiting for the user."));
      return;
    }
    let unsubscribe = () => {};
    const finish = () => {
      waiters.delete(id);
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      useBrowserPanelStore.getState().removeBrowserApproval(threadRef, id);
    };
    const onAbort = () => {
      finish();
      reject(new Error("The browser request stopped waiting for the user."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    waiters.set(id, (decision) => {
      finish();
      resolve(decision);
    });
    const asked: PendingBrowserApproval = { ...approval, id, waiting: true };
    store.enqueueBrowserApproval(threadRef, asked);
    onAsked?.(asked);
    // The question can also be withdrawn without an answer -- its tab closed --
    // and then there is nothing left to wait for.
    unsubscribe = useBrowserPanelStore.subscribe((state) => {
      const queue = selectPendingBrowserApprovals(state.pendingApprovalsByThreadKey, threadRef);
      if (waiters.has(id) && !queue.some((entry) => entry.id === id)) {
        finish();
        reject(new BrowserApprovalWithdrawn(approval.host));
      }
    });
  });
}

/** The question was withdrawn before anyone answered it: its tab closed. */
export class BrowserApprovalWithdrawn extends Error {
  constructor(host: string) {
    super(`The tab closed before the user answered, so ${host} was not opened.`);
  }
}

/**
 * Answers a question, and says whether the caller still has something to do.
 *
 * A question an agent is waiting on is only ever answered through the agent,
 * which loads the page itself: `"done"`, even when the agent has meanwhile
 * stopped waiting -- a click that lands just after a timeout, or a second click
 * before the bar redraws, must not load anything. A question nobody waits on
 * (a page's own blocked navigation, or one asked of a server too old to wait)
 * is removed, and `"load"` tells the caller to go there now that it is allowed.
 */
export function answerBrowserApproval(
  threadRef: ScopedThreadRef,
  approval: Pick<PendingBrowserApproval, "id" | "waiting">,
  decision: BrowserApprovalDecision,
): "done" | "load" {
  if (approval.waiting) {
    waiters.get(approval.id)?.(decision);
    return "done";
  }
  const queued = selectPendingBrowserApprovals(
    useBrowserPanelStore.getState().pendingApprovalsByThreadKey,
    threadRef,
  ).some((entry) => entry.id === approval.id);
  useBrowserPanelStore.getState().removeBrowserApproval(threadRef, approval.id);
  // Already answered (a double click) or withdrawn: nothing left to load.
  return queued && decision !== "decline" ? "load" : "done";
}

/** A unique id for a question nobody waits on. */
export function nextBrowserApprovalId(): string {
  sequence += 1;
  return `approval-${sequence}`;
}
