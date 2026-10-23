/**
 * Agents outside Threadlines, app-wide (docs/design/outside-agents.md).
 * Mounted once at the root; for this computer's owner it keeps the agents
 * stream open, shows the approval dialog over whatever page is open while a
 * sign-in waits (oldest first, with how many more wait behind it), and a
 * system notification when one arrives while nobody is looking at the window.
 *
 * The dialog closes only through its answer: Escape and a click outside do
 * nothing, since a sign-in left unanswered would only come back.
 */
import type { OutsideAgentPendingRequest } from "@threadlines/contracts";
import { Suspense, useEffect, useRef } from "react";

import {
  useOutsideAgentsAvailable,
  useOutsideAgentsSnapshot,
  useOutsideAgentsSync,
} from "../../environments/outsideAgents/outsideAgents";
import { nextOutsideAgentNotification } from "../../environments/outsideAgents/outsideAgents.logic";
import { isPageAttended } from "../../lib/pageAttention";
import { showSystemNotification } from "../../lib/systemNotification";
import { Dialog } from "../ui/dialog";
import { OutsideAgentDialog } from "./outsideAgentDialog";

const NO_REQUESTS: ReadonlyArray<OutsideAgentPendingRequest> = [];

const ignoreClose = () => undefined;

export function OutsideAgentsHost() {
  const available = useOutsideAgentsAvailable();
  useOutsideAgentsSync(available);
  const snapshot = useOutsideAgentsSnapshot();
  const pending = available ? (snapshot?.pending ?? NO_REQUESTS) : NO_REQUESTS;
  useSignInNotifications(pending);
  const head = pending[0] ?? null;
  return (
    <Dialog open={head !== null} onOpenChange={ignoreClose} disablePointerDismissal>
      {head !== null ? (
        <Suspense fallback={null}>
          <OutsideAgentDialog.Component
            key={head.requestId}
            subject={{ kind: "request", request: head, waitingBehind: pending.length - 1 }}
            onClose={ignoreClose}
          />
        </Suspense>
      ) : null}
    </Dialog>
  );
}

/** A system notification for each new sign-in nobody is looking at, at most one every 30 seconds. */
function useSignInNotifications(pending: ReadonlyArray<OutsideAgentPendingRequest>): void {
  const seenRef = useRef<ReadonlySet<string>>(new Set());
  const lastNotifiedAtRef = useRef<number | null>(null);
  useEffect(() => {
    const nowMs = Date.now();
    const next = nextOutsideAgentNotification({
      pending,
      seen: seenRef.current,
      lastNotifiedAtMs: lastNotifiedAtRef.current,
      nowMs,
      attended: isPageAttended(),
    });
    seenRef.current = next.seen;
    if (next.notify === null) return;
    const shown = showSystemNotification({
      title: `${next.notify.name} wants to use Threadlines`,
      body: `Check that its code is ${next.notify.code}, then allow or deny it in Threadlines.`,
      tag: "threadlines-outside-agent",
    });
    if (shown) lastNotifiedAtRef.current = nowMs;
  }, [pending]);
}
