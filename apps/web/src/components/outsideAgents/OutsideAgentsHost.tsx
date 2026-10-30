/**
 * Agents outside Threadlines, app-wide (docs/design/outside-agents.md), and
 * assistants (docs/design/assistants.md). Mounted once at the root; for this
 * computer's owner it keeps the agents stream open, shows the approval dialog
 * over whatever page is open while a sign-in of either kind waits (oldest
 * first, with how many more wait behind it), and a system notification when
 * one arrives while nobody is looking at the window. An assistant's sign-in
 * arrives once its page took this computer's code: the dialog then takes the
 * place of the code on Settings' Assistants group.
 *
 * The dialog closes only through its answer: Escape and a click outside do
 * nothing, since a sign-in left unanswered would only come back.
 */
import { Suspense, useEffect, useMemo, useRef } from "react";

import {
  useOutsideAgentsAvailable,
  useOutsideAgentsSnapshot,
  useOutsideAgentsSync,
} from "../../environments/outsideAgents/outsideAgents";
import {
  nextOutsideAgentNotification,
  type OutsideAgentWaitingSignIn,
  waitingOutsideAgentSignIns,
} from "../../environments/outsideAgents/outsideAgents.logic";
import { isPageAttended } from "../../lib/pageAttention";
import { showSystemNotification } from "../../lib/systemNotification";
import { Dialog } from "../ui/dialog";
import { OutsideAgentDialog } from "./outsideAgentDialog";
import type { OutsideAgentDialogSubject } from "./OutsideAgentDialogContent";

const NO_SIGN_INS: ReadonlyArray<OutsideAgentWaitingSignIn> = [];

const ignoreClose = () => undefined;

export function OutsideAgentsHost() {
  const available = useOutsideAgentsAvailable();
  useOutsideAgentsSync(available);
  const snapshot = useOutsideAgentsSnapshot();
  const waiting = useMemo(
    () => (available && snapshot !== null ? waitingOutsideAgentSignIns(snapshot) : NO_SIGN_INS),
    [available, snapshot],
  );
  useSignInNotifications(waiting);
  const head = waiting[0] ?? null;
  const subject: OutsideAgentDialogSubject | null =
    head === null
      ? null
      : head.kind === "local"
        ? { kind: "request", request: head, waitingBehind: waiting.length - 1 }
        : { kind: "assistant", signIn: head, waitingBehind: waiting.length - 1 };
  return (
    <Dialog open={subject !== null} onOpenChange={ignoreClose} disablePointerDismissal>
      {head !== null && subject !== null ? (
        <Suspense fallback={null}>
          <OutsideAgentDialog.Component
            key={head.requestId}
            subject={subject}
            onClose={ignoreClose}
          />
        </Suspense>
      ) : null}
    </Dialog>
  );
}

/** A system notification for each new sign-in nobody is looking at, at most one every 30 seconds. */
function useSignInNotifications(waiting: ReadonlyArray<OutsideAgentWaitingSignIn>): void {
  const seenRef = useRef<ReadonlySet<string>>(new Set());
  const lastNotifiedAtRef = useRef<number | null>(null);
  useEffect(() => {
    const nowMs = Date.now();
    const next = nextOutsideAgentNotification({
      pending: waiting,
      seen: seenRef.current,
      lastNotifiedAtMs: lastNotifiedAtRef.current,
      nowMs,
      attended: isPageAttended(),
    });
    seenRef.current = next.seen;
    if (next.notify === null) return;
    const shown = showSystemNotification({
      title: `${next.notify.name} wants to use Threadlines`,
      body:
        next.notify.kind === "local"
          ? `Check that its code is ${next.notify.code}, then allow or deny it in Threadlines.`
          : "Allow or deny it in Threadlines.",
      tag: "threadlines-outside-agent",
    });
    if (shown) lastNotifiedAtRef.current = nowMs;
  }, [waiting]);
}
