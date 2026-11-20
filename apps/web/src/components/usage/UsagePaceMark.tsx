import { cn } from "~/lib/utils";

/**
 * The pace mark on a usage bar: a short upright tick at how much of the
 * window has passed. Usage that stops left of it lasts until the reset. Put it
 * inside the bar's track, which needs `relative` and must not clip it.
 */
export function UsagePaceMark(props: { elapsedPercent: number; className?: string }) {
  const left = Math.max(0, Math.min(100, props.elapsedPercent));
  return (
    <span
      aria-hidden="true"
      data-usage-pace-mark=""
      className={cn(
        "-translate-x-1/2 -translate-y-1/2 pointer-events-none absolute top-1/2 h-2.5 w-0.5 rounded-full bg-foreground",
        props.className,
      )}
      style={{ left: `${left}%` }}
    />
  );
}

/** "12% used, 5% of the window passed", for a usage bar's accessible name. */
export function usagePaceLabel(elapsedPercent: number | undefined): string {
  return elapsedPercent === undefined
    ? ""
    : `, ${Math.round(elapsedPercent)}% of the window passed`;
}
