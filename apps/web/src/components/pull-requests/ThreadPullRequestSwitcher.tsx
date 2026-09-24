/**
 * The strip of pull request numbers across the top of the Pull request tab,
 * for a thread that has more than one: the one on its own branch, then the
 * ones its agent opened elsewhere. Plain numbers with the shown one in the
 * foreground; a thread with a single pull request draws nothing here.
 *
 * @module ThreadPullRequestSwitcher
 */
import { cn } from "../../lib/utils";

export function ThreadPullRequestSwitcher({
  numbers,
  selected,
  onSelect,
}: {
  readonly numbers: readonly number[];
  readonly selected: number | null;
  readonly onSelect: (number: number) => void;
}) {
  if (numbers.length < 2) {
    return null;
  }
  return (
    <div
      role="tablist"
      aria-label="Pull requests in this thread"
      className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-1.5 text-xs"
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
  );
}
