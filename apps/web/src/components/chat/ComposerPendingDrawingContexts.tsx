import { PencilIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { formatDrawingDescriptor, type DrawingContextDraft } from "~/lib/drawingContext";
import { formatPickedElementDescriptor } from "~/lib/pickedElementContext";
import { COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME } from "../composerInlineChip";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

interface ComposerPendingDrawingContextsProps {
  contexts: ReadonlyArray<DrawingContextDraft>;
  onRemove: (contextId: string) => void;
  onUpdateNote: (contextId: string, note: string) => void;
  className?: string;
}

const CHIP_CONTAINER_CLASS_NAME =
  "inline-flex max-w-56 items-center gap-0.5 rounded-md border border-border/70 bg-accent/40 py-1 pr-1 pl-2 transition-colors hover:bg-accent/60";

const CHIP_TRIGGER_CLASS_NAME =
  "inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-left text-[12px] font-medium leading-tight text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * A drawing, as one chip.
 *
 * It is one act, so it reads as one thing. Sending the picture and a chip per
 * circled element instead would put four items in the composer for a gesture
 * that took a second and had a single point to make, and would bury the note
 * under them.
 *
 * The picture lives behind the click, next to the note, because the chip only
 * needs to say that a drawing is attached -- what it shows is the reason to
 * open it.
 */
export function ComposerPendingDrawingContexts({
  contexts,
  onRemove,
  onUpdateNote,
  className,
}: ComposerPendingDrawingContextsProps) {
  if (contexts.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)} data-testid="drawing-chips">
      {contexts.map((context) => (
        <DrawingChip
          key={context.id}
          context={context}
          onRemove={onRemove}
          onUpdateNote={onUpdateNote}
        />
      ))}
    </div>
  );
}

function DrawingChip({
  context,
  onRemove,
  onUpdateNote,
}: {
  context: DrawingContextDraft;
  onRemove: (contextId: string) => void;
  onUpdateNote: (contextId: string, note: string) => void;
}) {
  const noteInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [open, setOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState(context.note ?? "");
  const descriptor = formatDrawingDescriptor(context);

  useEffect(() => {
    setNoteDraft(context.note ?? "");
  }, [context.note]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      const input = noteInputRef.current;
      if (input === null) {
        return;
      }
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [open]);

  const trimmed = noteDraft.trim();
  const changed = trimmed !== (context.note ?? "").trim();

  const save = () => {
    if (changed) {
      onUpdateNote(context.id, trimmed);
    }
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setNoteDraft(context.note ?? "");
        }
        setOpen(next);
      }}
    >
      <span className={CHIP_CONTAINER_CLASS_NAME}>
        <PopoverTrigger
          render={
            <button
              type="button"
              className={CHIP_TRIGGER_CLASS_NAME}
              aria-label={`Open ${descriptor}`}
              data-testid={`drawing-chip-${context.id}`}
            >
              <PencilIcon className="size-3 shrink-0 text-muted-foreground/70" />
              <span className="min-w-0 truncate">{descriptor}</span>
              {context.note === null ? null : (
                <span
                  aria-label="Has a note"
                  data-testid={`drawing-has-note-${context.id}`}
                  className="size-1 shrink-0 rounded-full bg-primary-readable"
                />
              )}
            </button>
          }
        />
        <button
          type="button"
          aria-label={`Remove ${descriptor}`}
          data-testid={`drawing-remove-${context.id}`}
          className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
          onClick={() => onRemove(context.id)}
        >
          <XIcon className="size-3" />
        </button>
      </span>

      <PopoverPopup
        className="w-72"
        viewportClassName="p-2 [--viewport-inline-padding:--spacing(2)]"
        side="top"
        align="start"
      >
        {/* The drawing itself, small: enough to recognise which one this is,
            not a second copy of the browser panel. */}
        <img
          src={context.imageDataUrl}
          alt="The page with your drawing on it"
          data-testid={`drawing-preview-${context.id}`}
          className="mb-1.5 max-h-40 w-full rounded-sm border border-border object-contain object-top"
        />
        {context.elements.length === 0 ? null : (
          <ul
            className="mb-1.5 flex flex-col gap-0.5"
            data-testid={`drawing-elements-${context.id}`}
          >
            {context.elements.map((element) => (
              <li
                key={element.selector}
                className="truncate font-mono text-[10px] text-muted-foreground"
              >
                {formatPickedElementDescriptor(element)}
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={noteInputRef}
          rows={2}
          value={noteDraft}
          onChange={(event) => setNoteDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              save();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setNoteDraft(context.note ?? "");
              setOpen(false);
            }
          }}
          placeholder="What about this?"
          className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ring"
          data-testid={`drawing-note-${context.id}`}
        />
        <div className="mt-1.5 flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="ms-auto"
            disabled={!changed}
            onClick={save}
            data-testid={`drawing-save-${context.id}`}
          >
            Save
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
