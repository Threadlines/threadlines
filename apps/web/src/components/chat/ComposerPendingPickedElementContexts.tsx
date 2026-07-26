import { MousePointerClickIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import {
  formatPickedElementContextLabel,
  type PickedElementContextDraft,
} from "~/lib/pickedElementContext";
import { COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME } from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerPendingPickedElementContextsProps {
  contexts: ReadonlyArray<PickedElementContextDraft>;
  onRemove: (contextId: string) => void;
  className?: string;
}

const CHIP_CONTAINER_CLASS_NAME =
  "inline-flex max-w-56 items-center gap-0.5 rounded-md border border-border/70 bg-accent/40 py-1 pr-1 pl-2 transition-colors hover:bg-accent/60";

/**
 * Elements picked in the browser preview, shown as removable chips.
 *
 * A chip rather than text in the prompt: it is evidence attached to the
 * question, so it should be dismissable without editing the sentence you are
 * writing, and it should not be something you have to type around.
 */
export function ComposerPendingPickedElementContexts({
  contexts,
  onRemove,
  className,
}: ComposerPendingPickedElementContextsProps) {
  if (contexts.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)} data-testid="picked-element-chips">
      {contexts.map((context) => (
        <div key={context.id} className={CHIP_CONTAINER_CLASS_NAME}>
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className="inline-flex min-w-0 items-center gap-1.5 text-[12px] font-medium leading-tight text-foreground"
                  data-testid={`picked-element-chip-${context.id}`}
                />
              }
            >
              <MousePointerClickIcon className="size-3 shrink-0 text-muted-foreground/70" />
              <span className="truncate">{formatPickedElementContextLabel(context)}</span>
            </TooltipTrigger>
            {/* The label is the short form; the tooltip carries what a truncated
                chip had to drop, which is what identifies it on the page. */}
            <TooltipPopup side="top" className="max-w-80">
              <span className="block font-mono text-[11px]">{context.selector}</span>
              <span className="block text-[11px] text-muted-foreground">
                {context.width}×{context.height} · {context.url}
              </span>
            </TooltipPopup>
          </Tooltip>
          <button
            type="button"
            aria-label={`Remove ${formatPickedElementContextLabel(context)}`}
            data-testid={`picked-element-remove-${context.id}`}
            className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
            onClick={() => onRemove(context.id)}
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
