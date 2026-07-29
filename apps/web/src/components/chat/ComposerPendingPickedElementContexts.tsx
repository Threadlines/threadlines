import { CrosshairIcon, MousePointerClickIcon, PaintbrushIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import {
  formatPickedElementDescriptor,
  formatStyleChange,
  type PickedElementContext,
  type PickedElementContextDraft,
} from "~/lib/pickedElementContext";
import { COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME } from "../composerInlineChip";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

interface ComposerPendingPickedElementContextsProps {
  contexts: ReadonlyArray<PickedElementContextDraft>;
  onRemove: (contextId: string) => void;
  onUpdateNote: (contextId: string, note: string) => void;
  /** Shows the element again in the preview; absent outside the desktop app. */
  onReveal?: ((context: PickedElementContextDraft) => void) | undefined;
  className?: string;
}

const CHIP_CONTAINER_CLASS_NAME =
  "inline-flex max-w-56 items-center gap-0.5 rounded-md border border-border/70 bg-accent/40 py-1 pr-1 pl-2 transition-colors hover:bg-accent/60";

const CHIP_TRIGGER_CLASS_NAME =
  "inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-left text-[12px] font-medium leading-tight text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * Elements picked in the browser preview, shown as removable chips.
 *
 * A chip rather than text in the prompt: it is evidence attached to the
 * question, so it should be dismissable without editing the sentence you are
 * writing, and it should not be something you have to type around.
 *
 * The chip names the element, because that is what it is. What you said about
 * it lives behind a click, next to the way back to it on the page -- the same
 * shape as the note on a highlighted quote.
 */
export function ComposerPendingPickedElementContexts({
  contexts,
  onRemove,
  onUpdateNote,
  onReveal,
  className,
}: ComposerPendingPickedElementContextsProps) {
  if (contexts.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)} data-testid="picked-element-chips">
      {contexts.map((context) => (
        <PickedElementContextChip
          key={context.id}
          chipId={context.id}
          context={context}
          onRemove={() => onRemove(context.id)}
          onUpdateNote={(note) => onUpdateNote(context.id, note)}
          onReveal={onReveal === undefined ? undefined : () => onReveal(context)}
        />
      ))}
    </div>
  );
}

/**
 * One picked element as a chip, in the composer or on a sent message.
 *
 * The two places differ only in what may still change: while composing, the
 * note is editable and the chip removable; once sent, the message is a record,
 * so the same popover shows the note as it was said. The way back to the
 * element on the page stays clickable in both.
 */
export function PickedElementContextChip({
  context,
  chipId,
  onRemove,
  onUpdateNote,
  onReveal,
}: {
  context: PickedElementContext;
  chipId: string;
  onRemove?: (() => void) | undefined;
  onUpdateNote?: ((note: string) => void) | undefined;
  onReveal?: (() => void) | undefined;
}) {
  const editable = onUpdateNote !== undefined;
  const noteInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [open, setOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState(context.note ?? "");
  const descriptor = formatPickedElementDescriptor(context);

  // Follow the stored note when it changes elsewhere.
  useEffect(() => {
    setNoteDraft(context.note ?? "");
  }, [context.note]);

  useEffect(() => {
    if (!open || !editable) {
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
  }, [open, editable]);

  const trimmed = noteDraft.trim();
  const changed = trimmed !== (context.note ?? "").trim();

  const save = () => {
    if (changed) {
      onUpdateNote?.(trimmed);
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
              aria-label={editable ? `Edit note on ${descriptor}` : `View ${descriptor}`}
              data-testid={`picked-element-chip-${chipId}`}
            >
              <MousePointerClickIcon className="size-3 shrink-0 text-muted-foreground/70" />
              <span className="min-w-0 truncate">{descriptor}</span>
              {/* A dot rather than the note itself: the chip stays one line,
                  and this only needs to say there is something behind it. */}
              {context.note === null ? null : (
                <span
                  aria-label="Has a note"
                  data-testid={`picked-element-has-note-${chipId}`}
                  className="size-1 shrink-0 rounded-full bg-primary-readable"
                />
              )}
              {context.styleChanges.length === 0 ? null : (
                <span
                  aria-label={`${context.styleChanges.length} proposed style changes`}
                  data-testid={`picked-element-style-count-${chipId}`}
                  className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  <PaintbrushIcon className="size-2.5" />
                  {context.styleChanges.length}
                </span>
              )}
            </button>
          }
        />
        {onRemove === undefined ? null : (
          <button
            type="button"
            aria-label={`Remove ${descriptor}`}
            data-testid={`picked-element-remove-${chipId}`}
            className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
            onClick={onRemove}
          >
            <XIcon className="size-3" />
          </button>
        )}
      </span>

      <PopoverPopup
        className="w-72"
        viewportClassName="p-2 [--viewport-inline-padding:--spacing(2)]"
        side="top"
        align="start"
      >
        <p className="truncate text-xs font-medium text-foreground">{descriptor}</p>
        <p className="mb-1.5 truncate font-mono text-[10px] text-muted-foreground/70">
          {context.selector}
        </p>
        {context.styleChanges.length === 0 ? null : (
          <ul
            className="mb-1.5 flex flex-col gap-0.5"
            data-testid={`picked-element-styles-${chipId}`}
          >
            {context.styleChanges.map((change) => (
              <li
                key={change.property}
                className="truncate font-mono text-[10px] text-muted-foreground"
              >
                {formatStyleChange(change)}
              </li>
            ))}
          </ul>
        )}
        {editable ? (
          /* A plain field rather than the shared Textarea: that one hardcodes a
             70px floor and form-sized padding on its inner element, which no
             prop from out here can reach. This card is meant to be small. */
          <textarea
            ref={noteInputRef}
            rows={2}
            value={noteDraft}
            onChange={(event) => setNoteDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter saves: a note is a line, not a paragraph. Shift keeps the
              // newline for anyone who wants one.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                save();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setNoteDraft(context.note ?? "");
                setOpen(false);
              }
            }}
            placeholder="What about this element?"
            className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ring"
            data-testid={`picked-element-note-${chipId}`}
          />
        ) : context.note === null ? null : (
          <p
            className="max-h-32 overflow-y-auto whitespace-pre-wrap text-xs leading-snug text-foreground"
            data-testid={`picked-element-note-${chipId}`}
          >
            {context.note}
          </p>
        )}
        {onReveal === undefined && !editable ? null : (
          <div className="mt-1.5 flex items-center gap-2">
            {onReveal === undefined ? null : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid={`picked-element-reveal-${chipId}`}
                onClick={onReveal}
              >
                <CrosshairIcon className="size-3.5" />
                Show in preview
              </Button>
            )}
            {editable ? (
              <Button
                type="button"
                size="sm"
                className="ms-auto"
                disabled={!changed}
                onClick={save}
                data-testid={`picked-element-save-${chipId}`}
              >
                Save
              </Button>
            ) : null}
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}
