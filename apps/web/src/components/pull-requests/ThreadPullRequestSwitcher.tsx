/**
 * The strip across the top of a thread's Pull request tab. For a thread with
 * more than one pull request it holds their numbers: the one on its own
 * branch, then the ones its agent opened elsewhere, plain, with the shown one
 * in the foreground. When the shown one's row above the composer was closed,
 * it also holds the way to bring that row back. With neither, it draws
 * nothing.
 *
 * @module ThreadPullRequestSwitcher
 */
import { cn } from "../../lib/utils";

export function ThreadPullRequestSwitcher({
  numbers,
  selected,
  onSelect,
  onShowAboveComposer,
}: {
  readonly numbers: readonly number[];
  readonly selected: number | null;
  readonly onSelect: (number: number) => void;
  /** Present while the shown pull request's row above the composer is closed. */
  readonly onShowAboveComposer?: (() => void) | undefined;
}) {
  const showNumbers = numbers.length > 1;
  if (!showNumbers && !onShowAboveComposer) {
    return null;
  }
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-1.5 text-xs">
      {showNumbers ? (
        <div
          role="tablist"
          aria-label="Pull requests in this thread"
          className="flex min-w-0 flex-wrap items-center gap-3"
        >
          {numbers.map((number) => {
            const active = number === selected;
            return (
              <button
                key={number}
                type="button"
                role="tab"
                aria-selected={active}
                className={cn(
                  "rounded-sm font-mono transition-colors focus-ring",
                  active
                    ? "text-foreground"
                    : "cursor-pointer text-muted-foreground hover:text-foreground",
                )}
                onClick={() => onSelect(number)}
              >
                #{number}
              </button>
            );
          })}
        </div>
      ) : null}
      {onShowAboveComposer ? (
        <button
          type="button"
          className="ml-auto shrink-0 cursor-pointer rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-ring"
          onClick={onShowAboveComposer}
        >
          Show above message box
        </button>
      ) : null}
    </div>
  );
}
