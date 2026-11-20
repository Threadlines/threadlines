import type { RoomAgentInviteChoice, ScopedThreadRef } from "@threadlines/contracts";
import { ChevronRightIcon } from "lucide-react";
import { memo, useState, useSyncExternalStore } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { cn, newCommandId } from "~/lib/utils";
import type { PendingRoomInvite } from "../../rooms";
import { Button } from "../ui/button";
import { failureNotice, toastManager } from "../ui/toast";
import { addComputerNotConnectedNotice } from "../computerConnectionNotices";

/**
 * Invites answered from this window, and how, from the click on. The panel
 * stays up until the thread's update takes it away, and it can be left and
 * opened again meanwhile, even while the answer is still on its way: every
 * copy of it follows this, so none offers the choices again.
 */
const answeredInvites = new Map<string, RoomAgentInviteChoice>();
const answeredInviteListeners = new Set<() => void>();

function setInviteAnswer(requestId: string, choice: RoomAgentInviteChoice | null): void {
  if (choice === null) answeredInvites.delete(requestId);
  else answeredInvites.set(requestId, choice);
  for (const listener of answeredInviteListeners) listener();
}

function subscribeInviteAnswers(listener: () => void): () => void {
  answeredInviteListeners.add(listener);
  return () => {
    answeredInviteListeners.delete(listener);
  };
}

/** What the panel says while an answer is on its way, in place of the buttons. */
function answeringLabel(choice: RoomAgentInviteChoice, invite: PendingRoomInvite): string {
  switch (choice) {
    case "teammate":
      return `Adding ${invite.toName} to the thread…`;
    case "review":
      return `Asking ${invite.toName} for a review…`;
    case "decline":
      return `Telling ${invite.fromName} not now…`;
  }
}

/**
 * An agent asks to bring in another agent for a review
 * (docs/design/rooms-agent-invites.md). Docked above the message box like a
 * tool approval, but the box stays usable: the user can answer, or write
 * something else first.
 */
export const ComposerAgentInvitePanel = memo(function ComposerAgentInvitePanel(props: {
  threadRef: ScopedThreadRef;
  invite: PendingRoomInvite;
}) {
  const { invite } = props;
  const responding = useSyncExternalStore(
    subscribeInviteAnswers,
    () => answeredInvites.get(invite.requestId) ?? null,
  );
  const [showRequest, setShowRequest] = useState(false);

  const respond = async (choice: RoomAgentInviteChoice) => {
    const api = readEnvironmentApi(props.threadRef.environmentId);
    if (!api) {
      addComputerNotConnectedNotice({
        environmentId: props.threadRef.environmentId,
        fallbackLabel: "This computer",
      });
      return;
    }
    setInviteAnswer(invite.requestId, choice);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.agent-invite.respond",
        commandId: newCommandId(),
        threadId: props.threadRef.threadId,
        requestId: invite.requestId,
        choice,
        createdAt: new Date().toISOString(),
      });
      // Answered: the panel says so until the thread's update takes it away,
      // which can land a moment after the reply. A second click in that gap
      // would be refused as an invite already answered.
    } catch (error) {
      setInviteAnswer(invite.requestId, null);
      toastManager.add(
        failureNotice({
          title: `Couldn't bring in ${invite.toName}`,
          error,
        }),
      );
    }
  };

  const teammateFirst = invite.suggestion === "teammate";
  const choices: ReadonlyArray<{ choice: RoomAgentInviteChoice; label: string }> = [
    { choice: "decline", label: "Not now" },
    ...(teammateFirst
      ? [
          { choice: "review" as const, label: "Review only" },
          { choice: "teammate" as const, label: "Add to thread" },
        ]
      : [
          { choice: "teammate" as const, label: "Add to thread" },
          { choice: "review" as const, label: "Review only" },
        ]),
  ];

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4" data-testid="agent-invite-panel">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm tracking-[0.2em] uppercase">Agent request</span>
          <span className="text-sm font-medium">
            {invite.fromName} wants {invite.toName} to review its work
          </span>
        </div>
        <p className="text-sm text-foreground" data-testid="agent-invite-reason">
          {invite.reason}
        </p>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={showRequest}
          onClick={() => setShowRequest((shown) => !shown)}
        >
          <ChevronRightIcon
            className={cn("size-3.5 transition-transform", showRequest && "rotate-90")}
          />
          What it will be asked
        </button>
        {showRequest ? (
          <p className="max-h-40 overflow-y-auto border-l border-border pl-3 text-sm whitespace-pre-wrap break-words text-muted-foreground">
            {invite.requestText}
          </p>
        ) : null}
        <p className="font-mono text-[11px] text-muted-foreground">
          {invite.toReasoning ? `${invite.toReasoning} reasoning · ` : ""}
          {invite.billing.label}
          {invite.billing.perUse ? " · billed per use" : ""}
        </p>
        {invite.joinsRoom ? (
          <p className="text-xs text-muted-foreground">
            Add to thread makes this a room, and revert turns off for good.
          </p>
        ) : null}
      </div>
      {responding !== null ? (
        // The row keeps the buttons' height, so the panel doesn't shift.
        <p
          className="mt-3 flex h-8 items-center justify-end text-sm text-muted-foreground sm:h-7"
          role="status"
          data-testid="agent-invite-answering"
        >
          {answeringLabel(responding, invite)}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {choices.map(({ choice, label }, index) => (
            <Button
              key={choice}
              size="sm"
              variant={
                choice === "decline"
                  ? "ghost"
                  : index === choices.length - 1
                    ? "default"
                    : "outline"
              }
              onClick={() => void respond(choice)}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
});
