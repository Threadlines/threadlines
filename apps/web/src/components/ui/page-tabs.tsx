import { cn } from "../../lib/utils";

/**
 * One tab in a page-level strip: text on a hairline, the active one underlined.
 * Wrap the buttons in a `role="tablist"` row with `border-b border-border`; the
 * -mb-px drops the active underline onto that hairline instead of above it.
 */
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
      aria-selected={active}
      aria-controls={panelId}
      className={cn(
        "-mb-px inline-flex cursor-pointer items-center gap-1.5 border-b-2 px-0.5 pb-2 text-[15px] font-medium transition-colors focus-ring",
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
    >
      {label}
      {count === undefined ? null : (
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{count}</span>
      )}
    </button>
  );
}
