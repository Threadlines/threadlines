import type { OrchestrationQueuedFollowUp } from "@threadlines/contracts";
import { CornerDownRightIcon, ListEndIcon, PencilIcon, XIcon } from "lucide-react";
import { memo } from "react";

import { type RoomAgentLabel, roomAgentKey } from "../../rooms";

/** A steer on its way into the running turn, shown until the turn takes it. */
export interface ComposerPendingSteer {
  readonly id: string;
  readonly text: string;
}

/**
 * The line a queued message shows: its first line of text, or what it
 * carries when it is attachments only.
 */
export function describeQueuedFollowUp(
  followUp: Pick<OrchestrationQueuedFollowUp, "text" | "attachments">,
  attachmentOnlyPrompt: string,
): string {
  const firstLine =
    followUp.text === attachmentOnlyPrompt ? "" : followUp.text.trim().split("\n")[0];
  if (firstLine) {
    return firstLine;
  }
  const count = followUp.attachments.length;
  return count === 1 ? "1 attachment" : `${count} attachments`;
}

const ACTION_CLASS =
  "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:text-foreground focus-visible:text-foreground focus-visible:outline-none";

/**
 * Messages sent while a turn runs, listed just above the composer: steers
 * still on their way into the running turn, then messages waiting for it to
 * finish. A waiting message can go back into the box to edit, or be removed.
 * `paused` means nothing is running to wait on (no turn, no background work
 * the agent will wake up for): the last turn was stopped or failed, so the
 * queue holds until the next turn finishes.
 */
export const ComposerFollowUpQueue = memo(function ComposerFollowUpQueue({
  steering,
  queued,
  paused,
  attachmentOnlyPrompt,
  roomAgents = null,
  onEdit,
  onRemove,
}: {
  readonly steering: ReadonlyArray<ComposerPendingSteer>;
  readonly queued: ReadonlyArray<OrchestrationQueuedFollowUp>;
  readonly paused: boolean;
  readonly attachmentOnlyPrompt: string;
  /** In a room, who each queued message is for. */
  readonly roomAgents?: ReadonlyMap<string, RoomAgentLabel> | null;
  readonly onEdit: (followUp: OrchestrationQueuedFollowUp) => void;
  readonly onRemove: (followUp: OrchestrationQueuedFollowUp) => void;
}) {
  if (steering.length === 0 && queued.length === 0) {
    return null;
  }
  return (
    <ul className="mx-auto mb-1.5 flex max-w-4xl flex-col px-3" data-chat-follow-up-queue="true">
      {steering.map((message) => (
        <li key={message.id} className="flex min-w-0 items-center gap-2 py-0.5 text-xs">
          <CornerDownRightIcon className="size-3 shrink-0 text-muted-foreground/70" />
          <span className="shrink-0 text-muted-foreground">Steering</span>
          <span className="min-w-0 truncate text-foreground/80">{message.text}</span>
        </li>
      ))}
      {queued.map((followUp) => (
        <li
          key={followUp.messageId}
          className="flex min-w-0 items-center gap-2 py-0.5 text-xs"
          data-chat-follow-up-queued={followUp.messageId}
        >
          <ListEndIcon className="size-3 shrink-0 text-muted-foreground/70" />
          <span
            className="shrink-0 text-muted-foreground"
            title={
              paused
                ? "The last reply stopped, so this waits until the next reply finishes."
                : "Sends when the current work finishes."
            }
          >
            {paused ? "Paused" : "Queued"}
            {roomAgents !== null
              ? ` for ${roomAgents.get(roomAgentKey(followUp.participantId))?.name ?? "an agent"}`
              : null}
          </span>
          <span className="min-w-0 flex-1 truncate text-foreground/80">
            {describeQueuedFollowUp(followUp, attachmentOnlyPrompt)}
          </span>
          <button
            type="button"
            className={ACTION_CLASS}
            aria-label="Edit queued message"
            title="Move back to the message box"
            onClick={() => onEdit(followUp)}
          >
            <PencilIcon className="size-3" />
          </button>
          <button
            type="button"
            className={ACTION_CLASS}
            aria-label="Remove queued message"
            title="Remove"
            onClick={() => onRemove(followUp)}
          >
            <XIcon className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
});
