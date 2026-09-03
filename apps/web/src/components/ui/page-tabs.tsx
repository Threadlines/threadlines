import type { KeyboardEvent } from "react";

import { cn } from "../../lib/utils";

/**
 * One tab in a page-level strip: text on a hairline, the active one underlined.
 * Wrap the buttons in a `role="tablist"` row with `border-b border-border`; the
 * -mb-px drops the active underline onto that hairline instead of above it.
 *
 * Keyboard use follows the tabs pattern: only the active tab is in the tab
 * order, and the arrow keys (plus Home and End) move between the strip's tabs
 * and select as they go. The strip needs no wrapper component for that; each
 * button finds its siblings through the tablist it sits in.
 */
/**
 * The id a tab carries, so its panel can name it back with `aria-labelledby`.
 * Derived from the panel and the label rather than passed in, because both
 * sides already have those.
 */
export function pageTabId(panelId: string, label: string): string {
  return `${panelId}-tab-${label.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`;
}

export function PageTabButton({
  label,
  count,
  active,
  panelId,
  onClick,
}: {
  label: string;
  /** Shown after the label in mono; omit when the number is not known up front. */
  count?: number;
  active: boolean;
  panelId?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={panelId === undefined ? undefined : pageTabId(panelId, label)}
      aria-selected={active}
      aria-controls={panelId}
      tabIndex={active ? 0 : -1}
      className={cn(
        // Baseline, not centre: the count is a smaller face than the label, and
        // centred it hangs above the label's baseline as though it were floating.
        "-mb-px inline-flex cursor-pointer items-baseline gap-1.5 border-b-2 px-0.5 pb-2 text-[15px] font-medium transition-colors focus-ring",
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
      onKeyDown={moveBetweenTabs}
    >
      {label}
      {count === undefined ? null : (
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{count}</span>
      )}
    </button>
  );
}

/** Arrow keys walk the enclosing tablist and select the tab they land on. */
function moveBetweenTabs(event: KeyboardEvent<HTMLButtonElement>) {
  const tablist = event.currentTarget.closest('[role="tablist"]');
  if (!tablist) return;
  const tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const index = tabs.indexOf(event.currentTarget);
  if (index < 0) return;
  let next: number;
  switch (event.key) {
    case "ArrowRight":
      next = (index + 1) % tabs.length;
      break;
    case "ArrowLeft":
      next = (index - 1 + tabs.length) % tabs.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = tabs.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  const target = tabs[next];
  if (target) {
    target.focus();
    target.click();
  }
}
