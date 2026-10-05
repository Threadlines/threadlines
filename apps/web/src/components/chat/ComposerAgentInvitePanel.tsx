import type { RoomAgentInviteChoice, ScopedThreadRef } from "@threadlines/contracts";
import { ChevronRightIcon } from "lucide-react";
import { memo, useState } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { cn, newCommandId } from "~/lib/utils";
import type { PendingRoomInvite } from "../../rooms";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

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
  const [responding, setResponding] = useState(false);
  const [showRequest, setShowRequest] = useState(false);

  const respond = async (choice: RoomAgentInviteChoice) => {
    const api = readEnvironmentApi(props.threadRef.environmentId);
    if (!api) {
      toastManager.add({ type: "error", title: "This computer is not connected." });
      return;
    }
    setResponding(true);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.agent-invite.respond",
        commandId: newCommandId(),
        threadId: props.threadRef.threadId,
        requestId: invite.requestId,
        choice,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not bring in ${invite.toName}`,
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setResponding(false);
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
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {choices.map(({ choice, label }, index) => (
          <Button
            key={choice}
            size="sm"
            variant={
              choice === "decline" ? "ghost" : index === choices.length - 1 ? "default" : "outline"
            }
            disabled={responding}
            onClick={() => void respond(choice)}
          >
            {label}
          </Button>
        ))}
      </div>
    </div>
  );
});
