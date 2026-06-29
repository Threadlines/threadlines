import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

import type { TranscriptHighlightContextSelection } from "~/lib/transcriptHighlightContext";
import { formatTranscriptHighlightContextLabel } from "~/lib/transcriptHighlightContext";

/**
 * Shared key handling for highlight-note textareas: Enter submits, Shift+Enter
 * inserts a newline, Escape cancels. Guards against IME composition so Enter
 * does not submit mid-composition.
 */
export function handleTranscriptHighlightNoteKeyDown(
  event: ReactKeyboardEvent<HTMLTextAreaElement>,
  handlers: { onSubmit: () => void; onCancel: () => void },
): void {
  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
    event.preventDefault();
    handlers.onSubmit();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    handlers.onCancel();
  }
}

export const CONTEXT_PREVIEW_CARD_LABEL_CLASS_NAME =
  "font-medium text-[11px] text-muted-foreground uppercase tracking-wide";
export const TRANSCRIPT_HIGHLIGHT_CARD_LABEL_CLASS_NAME = CONTEXT_PREVIEW_CARD_LABEL_CLASS_NAME;

const TRANSCRIPT_HIGHLIGHT_CARD_QUOTE_CLASS_NAME =
  "max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 text-xs leading-snug text-muted-foreground";

/**
 * Shared scaffold for the highlight-context detail card: the role heading plus
 * the read-only quoted span. The note area (editable in the composer, read-only
 * in chat history) is supplied by the caller as children.
 */
export function TranscriptHighlightContextCard({
  context,
  children,
}: {
  context: Pick<TranscriptHighlightContextSelection, "sourceRole" | "selectedText">;
  children: ReactNode;
}) {
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className={TRANSCRIPT_HIGHLIGHT_CARD_LABEL_CLASS_NAME}>
          {formatTranscriptHighlightContextLabel(context)}
        </span>
        <p className={TRANSCRIPT_HIGHLIGHT_CARD_QUOTE_CLASS_NAME}>{context.selectedText}</p>
      </div>
      {children}
    </div>
  );
}
