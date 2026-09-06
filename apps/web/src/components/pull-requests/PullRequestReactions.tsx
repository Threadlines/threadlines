/**
 * The reactions under a remark, and the picker that adds one. The same bar
 * serves the description, a conversation comment and a comment on a diff line;
 * only the subject the host is told about differs.
 *
 * A press moves the count at once and the host's own numbers replace it on the
 * next read; a refusal drops the press and says so, so the bar never lies for
 * longer than the round trip and the count never moves back unexplained.
 */
import type {
  EnvironmentId,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestRef,
} from "@threadlines/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SmilePlusIcon } from "lucide-react";
import { useState } from "react";

import { pullRequestReactionMutationOptions } from "../../lib/pullRequestsReactQuery";
import { cn } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { TooltipWrapper } from "../ui/tooltip";
import {
  PULL_REQUEST_REACTION_ORDER,
  applyPendingPullRequestReactions,
  pullRequestReactionEmoji,
  pullRequestReactionName,
} from "./pullRequests.logic";

// A chip is small enough to miss with a thumb, so a coarse pointer gets a
// taller, wider target around the same glyph.
const CHIP_CLASS =
  "inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 font-mono text-[11px] leading-none tabular-nums transition-colors focus-ring pointer-coarse:h-8 pointer-coarse:px-2.5";

const EMPTY_PENDING: ReadonlyMap<PullRequestReactionContent, boolean> = new Map();

/** What the host last said, so a press in flight is forgotten once real counts land. */
function reactionsSignature(reactions: readonly PullRequestReaction[]): string {
  return reactions
    .map((reaction) => `${reaction.content}:${reaction.count}:${reaction.viewerReacted ? 1 : 0}`)
    .join(" ");
}

export function PullRequestReactionBar({
  reactions,
  canReact,
  subjectId,
  environmentId,
  reference,
  className,
}: {
  readonly reactions: readonly PullRequestReaction[];
  readonly canReact: boolean;
  /** Absent reacts to the pull request's own description. */
  readonly subjectId?: string;
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly className?: string;
}) {
  const queryClient = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState<{
    readonly signature: string;
    readonly values: ReadonlyMap<PullRequestReactionContent, boolean>;
  }>({ signature: "", values: EMPTY_PENDING });
  const setReaction = useMutation(
    pullRequestReactionMutationOptions({ environmentId, reference, queryClient }),
  );

  const signature = reactionsSignature(reactions);
  const values = pending.signature === signature ? pending.values : EMPTY_PENDING;
  const shown = applyPendingPullRequestReactions(reactions, values);

  const toggle = (content: PullRequestReactionContent, reacted: boolean) => {
    setPending({ signature, values: new Map([...values, [content, reacted]]) });
    setReaction.mutate(
      { ...(subjectId === undefined ? {} : { subjectId }), content, reacted },
      {
        onError: (error) => {
          setPending((current) => {
            const next = new Map(current.values);
            next.delete(content);
            return { signature: current.signature, values: next };
          });
          // The count springing back on its own would read as a glitch, so the
          // refusal is said out loud where the eye is not.
          toastManager.add({
            type: "error",
            title: "That reaction could not be saved",
            ...(error instanceof Error && error.message.trim().length > 0
              ? { description: error.message }
              : {}),
            data: { hideCopyButton: true },
          });
        },
      },
    );
  };

  if (shown.length === 0 && !canReact) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {shown.map((reaction) => (
        <TooltipWrapper key={reaction.content} tooltip={pullRequestReactionName(reaction.content)}>
          <button
            type="button"
            aria-pressed={reaction.viewerReacted}
            aria-label={`${pullRequestReactionName(reaction.content)}, ${reaction.count}`}
            disabled={!canReact}
            className={cn(
              CHIP_CLASS,
              reaction.viewerReacted
                ? "bg-accent text-foreground"
                : "text-muted-foreground/70 hover:text-foreground",
              canReact ? "hover:bg-accent" : "cursor-default",
            )}
            onClick={() => toggle(reaction.content, !reaction.viewerReacted)}
          >
            <span aria-hidden>{pullRequestReactionEmoji(reaction.content)}</span>
            {reaction.count}
          </button>
        </TooltipWrapper>
      ))}

      {canReact ? (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="Add a reaction"
                data-testid="pull-request-reaction-add"
                className={cn(
                  CHIP_CLASS,
                  "px-1 text-muted-foreground/60 hover:bg-accent hover:text-foreground",
                  // A control only a mouse can find is no control, so it stays
                  // put once focused or open, and whenever there is a chip
                  // beside it to explain what it does.
                  shown.length === 0 &&
                    !pickerOpen &&
                    "opacity-0 transition-opacity group-hover/reactions:opacity-100 group-focus-within/reactions:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
                )}
              />
            }
          >
            <SmilePlusIcon aria-hidden className="size-3.5" />
          </PopoverTrigger>
          <PopoverPopup align="start" side="top" className="w-auto">
            <div className="flex items-center gap-0.5">
              {PULL_REQUEST_REACTION_ORDER.map((content) => {
                const reacted =
                  shown.find((reaction) => reaction.content === content)?.viewerReacted ?? false;
                return (
                  <button
                    key={content}
                    type="button"
                    aria-pressed={reacted}
                    aria-label={pullRequestReactionName(content)}
                    className={cn(
                      "flex size-7 cursor-pointer items-center justify-center rounded-md text-base transition-colors hover:bg-accent focus-ring",
                      reacted && "bg-accent",
                    )}
                    onClick={() => {
                      setPickerOpen(false);
                      toggle(content, !reacted);
                    }}
                  >
                    <span aria-hidden>{pullRequestReactionEmoji(content)}</span>
                  </button>
                );
              })}
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
}
