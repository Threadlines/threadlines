import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

/**
 * The one-line header of a shelf at the foot of the thread list (Wrapped,
 * General chats): its name and count, an optional note, then a hairline
 * running out to the fold chevron. The line up to the chevron is the
 * control. The chevron points up while the shelf is closed: it opens upward.
 * An `action` (General chats' New chat) sits after the chevron, its own button.
 */
export function InboxShelfHeader({
  label,
  open,
  onToggle,
  testId,
  detail,
  action,
  measured = false,
}: {
  readonly label: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly testId: string;
  /** Beside the name, before the hairline ("· 2 today"). */
  readonly detail?: ReactNode;
  /** A button of its own at the line's end. */
  readonly action?: ReactNode;
  /** The Wrapped shelf's header, which the column measures (useInboxColumnLayout). */
  readonly measured?: boolean;
}) {
  const toggle = (
    <button
      type="button"
      data-thread-selection-safe
      data-inbox-shelf-header={measured ? "" : undefined}
      data-testid={testId}
      aria-expanded={open}
      className={cn(
        "group/section-header flex min-w-0 cursor-pointer items-center gap-2 py-2 pl-3 text-left select-none focus-ring",
        action ? "flex-1 pr-1.5" : "w-full shrink-0 pr-3",
      )}
      onClick={onToggle}
    >
      <span className="shrink-0 text-[11px] font-medium text-muted-foreground transition-colors group-hover/section-header:text-foreground">
        {label}
      </span>
      {detail}
      <span aria-hidden="true" className="h-px min-w-3 flex-1 bg-sidebar-border" />
      <ChevronDownIcon
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-150 group-hover/section-header:text-foreground",
          !open && "rotate-180",
        )}
      />
    </button>
  );
  if (!action) return toggle;
  return (
    <div className="flex w-full shrink-0 items-center pr-2">
      {toggle}
      {action}
    </div>
  );
}
