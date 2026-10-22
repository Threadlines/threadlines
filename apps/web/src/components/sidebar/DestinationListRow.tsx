import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { AttentionCounts } from "./AttentionCounts";

/**
 * One row of a page's own list beside the rail (a computer on Fleet, All
 * computers, All tasks): a plain glyph, its name with what waits and works
 * there, and a mono meta line. Pressed while the page shows it.
 */
export function DestinationListRow({
  testId,
  selected,
  disabled = false,
  icon,
  title,
  meta,
  needsYou = 0,
  working = 0,
  onSelect,
}: {
  readonly testId: string;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly icon: ReactNode;
  readonly title: string;
  readonly meta: string | null;
  readonly needsYou?: number;
  readonly working?: number;
  readonly onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-testid={testId}
        aria-pressed={disabled ? undefined : selected}
        disabled={disabled}
        className={cn(
          "flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors select-none focus-ring",
          disabled
            ? "cursor-default"
            : selected
              ? "cursor-pointer bg-sidebar-accent"
              : "cursor-pointer hover:bg-sidebar-accent/60 active:bg-sidebar-accent/80",
        )}
        onClick={onSelect}
      >
        <span className="mt-px flex size-[18px] shrink-0 items-center justify-center text-muted-foreground">
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13.5px] leading-[19px] font-medium text-foreground">
              {title}
            </span>
            <AttentionCounts needsYou={needsYou} working={working} />
          </span>
          {meta ? (
            <span className="truncate font-mono text-[10.5px] leading-4 text-muted-foreground">
              {meta}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
