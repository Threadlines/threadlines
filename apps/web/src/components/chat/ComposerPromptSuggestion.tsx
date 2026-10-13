import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useLexicalIsTextContentEmpty } from "@lexical/react/useLexicalIsTextContentEmpty";
import { $getRoot, $getSelection, $isRangeSelection, type LexicalEditor } from "lexical";
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";

import { startPromptSuggestionSweeps } from "~/lib/promptSuggestions";
import { cn } from "~/lib/utils";

/**
 * An agent's guess at the next message, as the composer's editor draws it.
 * Which suggestion shows, and when, is decided in `lib/promptSuggestions`.
 */
export interface ComposerPromptSuggestionDisplay {
  /** A new id is a new suggestion, which fades in once. */
  readonly id: string;
  readonly text: string;
  /**
   * The rest still to type while the typed text starts the suggestion; null
   * when it doesn't. An empty box shows the whole suggestion either way.
   */
  readonly remainder: string | null;
  /** The small line under the suggestion: what "@", "$" and "/" do here. */
  readonly hint: string;
  readonly onAccept: () => void;
}

export function promptSuggestionAriaPlaceholder(text: string): string {
  return `Suggested: ${text}. Press Tab to use it.`;
}

function $hasRangeSelection(): boolean {
  const selection = $getSelection();
  return $isRangeSelection(selection) && !selection.isCollapsed();
}

/**
 * Whether the rest of a suggestion can show after the cursor: not with words
 * selected, where it would read as continuing the selection, and not once the
 * editor scrolls, which the overlay does not follow. Tab completes only when
 * this holds, so it never adds words that aren't on screen.
 */
export function canShowPromptCompletion(editor: LexicalEditor): boolean {
  if (editor.getEditorState().read($hasRangeSelection)) {
    return false;
  }
  const root = editor.getRootElement();
  return root === null || root.scrollHeight <= root.clientHeight + 1;
}

/** What `useLexicalIsTextContentEmpty(editor, false)` tracks, read on demand. */
function isEditorEmpty(editor: LexicalEditor): boolean {
  return (
    !editor.isComposing() && editor.getEditorState().read(() => $getRoot().getTextContent() === "")
  );
}

/**
 * Laid over the editor, in its type. An empty box shows the suggestion where
 * the hint goes, with the hint's "@ / $" help on a small line below. While
 * the typed text starts the suggestion, an invisible copy of it pushes the
 * rest to just after the cursor, so the gray words continue the typed ones;
 * the rest stops at the editor's last whole line instead of running into the
 * toolbar. Mount it keyed by the suggestion's id: it stays mounted while the
 * box fills and empties, so the fade-in and the sheen that sweeps the words
 * play for a suggestion's arrival, not each time the box empties.
 */
export function ComposerPromptSuggestion({
  suggestion,
  value,
}: {
  suggestion: ComposerPromptSuggestionDisplay;
  value: string;
}) {
  const [editor] = useLexicalComposerContext();
  // Empty and not mid-IME. Whitespace counts as text, as in the composer's
  // own check, so a space hides a suggestion that Tab could no longer take.
  const isEmpty = useLexicalIsTextContentEmpty(editor, false);
  const [completionShown, setCompletionShown] = useState(() => canShowPromptCompletion(editor));
  // index.css sweeps a sheen through the words and lights the Tab key while
  // this is set: as the suggestion arrives, then a few reminders. A sweep
  // needs its words on screen from the start: it is skipped over typed text
  // and typing ends it, so emptying the box again never replays one part-way.
  const [sweeping, setSweeping] = useState(() => isEditorEmpty(editor));
  useEffect(
    () => startPromptSuggestionSweeps((next) => setSweeping(next && isEditorEmpty(editor))),
    [editor],
  );
  // Whole lines that fit in the editor as it stands; it grows with the typed
  // text, so the rest always gets at least the last typed line's remainder.
  const rootRef = useRef<HTMLDivElement>(null);
  const [visibleLines, setVisibleLines] = useState(2);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      setCompletionShown(canShowPromptCompletion(editor));
      if (!isEditorEmpty(editor)) {
        setSweeping(false);
      }
      const lineHeight = Number.parseFloat(getComputedStyle(root).lineHeight);
      if (lineHeight > 0) {
        setVisibleLines(Math.max(1, Math.floor((root.clientHeight + 1) / lineHeight)));
      }
    };
    measure();
    // Update listeners run once the editor's DOM is current; the observer
    // catches a width change rewrapping the text.
    const unregister = editor.registerUpdateListener(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => {
      unregister();
      observer.disconnect();
    };
  }, [editor]);

  return (
    <div
      ref={rootRef}
      data-prompt-suggestion="true"
      data-sweeping={sweeping ? "true" : undefined}
      className="composer-prompt-suggestion pointer-events-none absolute inset-0 text-[16px] leading-relaxed sm:text-[14px]"
    >
      {isEmpty ? (
        <>
          <p
            aria-hidden="true"
            data-prompt-suggestion-text="true"
            className="composer-prompt-suggestion-text line-clamp-2"
          >
            {/* The sheen runs through this inline box, so it follows the
                words line by line instead of crossing the empty box. */}
            <span>{suggestion.text}</span>
          </p>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/35">
            <PromptSuggestionAcceptKey
              onAccept={suggestion.onAccept}
              className="composer-prompt-suggestion-key"
            />
            <span aria-hidden="true" className="truncate">
              <span className="pointer-coarse:hidden">to use · </span>
              <span className="hidden pointer-coarse:inline">· </span>
              {suggestion.hint}
            </span>
          </p>
        </>
      ) : suggestion.remainder !== null && completionShown ? (
        // Wraps exactly like the editor: same width, type and white-space
        // rules. The break opportunity between the two halves keeps a word
        // the rest completes from pulling the typed part onto the next line.
        <p
          data-prompt-suggestion-remainder="true"
          className="line-clamp-(--prompt-suggestion-lines) whitespace-pre-wrap wrap-break-word"
          style={{ "--prompt-suggestion-lines": visibleLines } as CSSProperties}
        >
          <span aria-hidden="true" className="text-transparent">
            {value}
          </span>
          <wbr />
          <span aria-hidden="true" className="text-muted-foreground">
            {suggestion.remainder}
          </span>
          <PromptSuggestionAcceptKey onAccept={suggestion.onAccept} className="ms-1.5" />
        </p>
      ) : null}
    </div>
  );
}

/**
 * The Tab key shown with a suggestion. It also takes the suggestion when
 * clicked, and on a touch screen, which has no Tab key, it reads "Use".
 */
function PromptSuggestionAcceptKey({
  onAccept,
  className,
}: {
  onAccept: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label="Use the suggestion"
      data-prompt-suggestion-accept="true"
      className={cn(
        "pointer-events-auto inline-flex h-4 shrink-0 cursor-pointer select-none items-center rounded-sm bg-muted px-1 align-[1px] font-medium font-sans text-[10px] leading-none text-muted-foreground transition-colors hover:text-foreground pointer-coarse:h-6 pointer-coarse:px-2 pointer-coarse:text-xs",
        className,
      )}
      // Keep the cursor in the editor; taking the suggestion focuses it anyway.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onAccept}
    >
      <span className="pointer-coarse:hidden">Tab</span>
      <span className="hidden pointer-coarse:inline">Use</span>
    </button>
  );
}
