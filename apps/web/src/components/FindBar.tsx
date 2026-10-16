import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, Ref } from "react";

import { cn, isMacPlatform } from "~/lib/utils";

const FIND_BUTTON_CLASS_NAME =
  "inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

/** Where a find stands, as its count says it. */
export type FindBarTally =
  /** Still counting (a query being typed, a long chat being read). */
  | { readonly kind: "pending" }
  | { readonly kind: "matches"; readonly current: number; readonly total: number };

function formatTally(tally: FindBarTally): string {
  if (tally.kind === "pending") return "…";
  if (tally.total === 0) return "No results";
  return `${tally.current} of ${tally.total}`;
}

/**
 * Next / previous from the keyboard: Enter and Shift+Enter in the field, and
 * anywhere in the bar F3 / Shift+F3 or Cmd+G / Cmd+Shift+G (Ctrl+G elsewhere).
 * Null for any other key.
 */
export function findStepFromKey(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">,
  platform: string = navigator.platform,
): 1 | -1 | null {
  if (event.altKey) return null;
  const direction = event.shiftKey ? -1 : 1;
  if (event.key === "F3" && !event.metaKey && !event.ctrlKey) return direction;
  const mod = isMacPlatform(platform) ? event.metaKey : event.ctrlKey;
  if (event.key.toLowerCase() === "g" && mod) return direction;
  return null;
}

/**
 * The find bar: a field, its count, previous, next and close. Floats over
 * what it searches (find in chat, the browser panel's find in page); the
 * caller places it and does the finding.
 */
export function FindBar({
  query,
  onQueryChange,
  onStep,
  onClose,
  tally,
  placeholder,
  inputRef,
  testIdPrefix,
  className,
  canStep: canStepOverride,
}: {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly onStep: (direction: 1 | -1) => void;
  readonly onClose: () => void;
  /** Null hides the count (nothing typed yet). */
  readonly tally: FindBarTally | null;
  readonly placeholder: string;
  readonly inputRef?: Ref<HTMLInputElement> | undefined;
  /** Prefix for the bar's test ids (`<prefix>-bar`, `-input`, `-tally`, ...). */
  readonly testIdPrefix: string;
  readonly className?: string | undefined;
  /** Whether next / previous do anything; by default, when there are matches. */
  readonly canStep?: boolean | undefined;
}) {
  const canStep = canStepOverride ?? (tally?.kind === "matches" && tally.total > 0);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // Closing the bar is all Escape does here: nothing under it (a
      // selection, an armed browser tool) hears it too.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const fromField = event.target instanceof HTMLInputElement;
    const direction =
      event.key === "Enter" && fromField && !event.nativeEvent.isComposing
        ? event.shiftKey
          ? -1
          : 1
        : findStepFromKey(event);
    if (direction !== null) {
      event.preventDefault();
      event.stopPropagation();
      if (canStep) onStep(direction);
    }
  };

  return (
    // The keys are the bar's own, wherever in it focus is.
    <div
      className={cn(
        "flex items-center gap-1 rounded-lg border border-border bg-popover py-1 pr-1 pl-2 text-popover-foreground elevate-popover",
        className,
      )}
      data-testid={`${testIdPrefix}-bar`}
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-6 w-44 min-w-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        data-testid={`${testIdPrefix}-input`}
        spellCheck={false}
        autoComplete="off"
      />
      {tally === null ? null : (
        <span
          className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums"
          data-testid={`${testIdPrefix}-tally`}
          aria-live="polite"
        >
          {formatTally(tally)}
        </span>
      )}
      <span className="h-3.5 w-px shrink-0 bg-border" />
      <button
        type="button"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        data-testid={`${testIdPrefix}-previous`}
        className={FIND_BUTTON_CLASS_NAME}
        disabled={!canStep}
        onClick={() => onStep(-1)}
      >
        <ChevronUpIcon className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="Next match"
        title="Next match (Enter)"
        data-testid={`${testIdPrefix}-next`}
        className={FIND_BUTTON_CLASS_NAME}
        disabled={!canStep}
        onClick={() => onStep(1)}
      >
        <ChevronDownIcon className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="Close find"
        title="Close (Esc)"
        data-testid={`${testIdPrefix}-close`}
        className={FIND_BUTTON_CLASS_NAME}
        onClick={onClose}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
