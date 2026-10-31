import { cn } from "../../lib/utils";

/**
 * One entry in a page size picker: the size's name, then its dimensions (or,
 * for Responsive, what it does) muted beside it. Shared by the browser's size
 * menu and the Settings row, so both lists read the same.
 */
export function PageSizeLabel({
  label,
  detail,
  mono = true,
}: {
  label: string;
  detail: string;
  /** Dimensions set in mono so their digits line up; words are not. */
  mono?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-4">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span
        className={cn(
          "shrink-0 text-muted-foreground",
          mono ? "font-mono text-[11px] tabular-nums" : "text-xs",
        )}
      >
        {detail}
      </span>
    </span>
  );
}
