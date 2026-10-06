import { cn } from "../../lib/utils";

/** "In use", "Not in use", "Community agents": a section title above its run of agent rows. */
export function ProviderGroupHeading({
  label,
  count,
  first = false,
}: {
  label: string;
  /** Left out while the number isn't known yet. Text for a narrowed list ("3 of 29"). */
  count?: number | string | undefined;
  first?: boolean;
}) {
  return (
    <div className={cn("flex items-baseline gap-2 px-1 pb-2", first ? "pt-0" : "pt-7")}>
      <h2 className="text-[15px] leading-5 font-semibold text-foreground">{label}</h2>
      {count === undefined ? null : (
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{count}</span>
      )}
    </div>
  );
}
