import { useEffect, useId, useRef, useState } from "react";
import { SquarePenIcon, Trash2Icon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { TranscriptHighlightContextDraft } from "~/lib/transcriptHighlightContext";
import { formatTranscriptHighlightContextPreview } from "~/lib/transcriptHighlightContext";
import { COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME } from "../composerInlineChip";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import {
  handleTranscriptHighlightNoteFormSubmit,
  handleTranscriptHighlightNoteKeyDown,
  TRANSCRIPT_HIGHLIGHT_CARD_LABEL_CLASS_NAME,
  TranscriptHighlightContextCard,
} from "./TranscriptHighlightContextCard";

interface ComposerPendingTranscriptHighlightContextsProps {
  contexts: ReadonlyArray<TranscriptHighlightContextDraft>;
  onRemove: (contextId: string) => void;
  onUpdateNote: (contextId: string, note: string) => void;
  className?: string;
}

const CHIP_CONTAINER_CLASS_NAME =
  "inline-flex max-w-56 items-center gap-0.5 rounded-md border border-border/70 bg-accent/40 py-1 pr-1 pl-2 transition-colors hover:bg-accent/60";

const CHIP_TRIGGER_CLASS_NAME =
  "inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-[12px] font-medium leading-tight text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function ComposerPendingTranscriptHighlightContexts({
  contexts,
  onRemove,
  onUpdateNote,
  className,
}: ComposerPendingTranscriptHighlightContextsProps) {
  if (contexts.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {contexts.map((context) => (
        <TranscriptHighlightChip
          key={context.id}
          context={context}
          onRemove={onRemove}
          onUpdateNote={onUpdateNote}
        />
      ))}
    </div>
  );
}

function TranscriptHighlightChip({
  context,
  onRemove,
  onUpdateNote,
}: {
  context: TranscriptHighlightContextDraft;
  onRemove: (contextId: string) => void;
  onUpdateNote: (contextId: string, note: string) => void;
}) {
  const noteFieldId = useId();
  const noteInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [open, setOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState(context.note);

  const preview = formatTranscriptHighlightContextPreview(context);
  const roleWord = context.sourceRole === "assistant" ? "assistant" : "your";

  // Keep the editable draft aligned with the stored note when it changes elsewhere.
  useEffect(() => {
    setNoteDraft(context.note);
  }, [context.note]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      const input = noteInputRef.current;
      if (!input) {
        return;
      }
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setNoteDraft(context.note);
    }
    setOpen(nextOpen);
  };

  const trimmedDraft = noteDraft.trim();
  const canSave = trimmedDraft.length > 0 && trimmedDraft !== context.note.trim();

  const handleSave = () => {
    if (!canSave) {
      return;
    }
    onUpdateNote(context.id, noteDraft);
    setOpen(false);
  };

  const handleCancel = () => {
    setNoteDraft(context.note);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <span className={CHIP_CONTAINER_CLASS_NAME}>
        <PopoverTrigger
          render={
            <button
              type="button"
              className={CHIP_TRIGGER_CLASS_NAME}
              aria-label={`Edit note on highlighted ${roleWord} text`}
            >
              <SquarePenIcon className="size-3.5 shrink-0 opacity-85" />
              <span className="min-w-0 truncate">{`"${preview}"`}</span>
            </button>
          }
        />
        <button
          type="button"
          aria-label={`Remove note on highlighted ${roleWord} text`}
          onClick={() => onRemove(context.id)}
          className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
        >
          <XIcon className="size-3" />
        </button>
      </span>
      <PopoverPopup
        side="top"
        align="start"
        sideOffset={8}
        className="w-72 max-w-[calc(100vw-2rem)]"
      >
        <form
          className="w-full"
          onSubmit={(event) => handleTranscriptHighlightNoteFormSubmit(event, handleSave)}
        >
          <TranscriptHighlightContextCard context={context}>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={noteFieldId} className={TRANSCRIPT_HIGHLIGHT_CARD_LABEL_CLASS_NAME}>
                Your note
              </label>
              <Textarea
                id={noteFieldId}
                ref={noteInputRef}
                size="sm"
                value={noteDraft}
                onChange={(event) => setNoteDraft(event.currentTarget.value)}
                placeholder="Add context for this highlight"
                className="text-xs"
                onKeyDown={(event) =>
                  handleTranscriptHighlightNoteKeyDown(event, {
                    onSubmit: handleSave,
                    onCancel: handleCancel,
                  })
                }
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onRemove(context.id)}
                className="text-muted-foreground hover:text-destructive-foreground"
              >
                <Trash2Icon className="size-3.5" />
                Remove
              </Button>
              <div className="flex items-center gap-1.5">
                <Button type="button" variant="ghost" size="xs" onClick={handleCancel}>
                  Cancel
                </Button>
                <Button type="submit" size="xs" disabled={!canSave}>
                  Save
                </Button>
              </div>
            </div>
          </TranscriptHighlightContextCard>
        </form>
      </PopoverPopup>
    </Popover>
  );
}
