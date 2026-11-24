import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The pace mark on a usage bar: a short upright tick at how much of the
 * window has passed. Usage that stops left of it lasts until the reset. Put it
 * inside the bar's track, which needs `relative` and must not clip it.
 *
 * Hovering the tick says how much of the window has passed (`detail`, from the
 * shared usage presentation). The hover area is wider than the tick so it can
 * be found; keyboard and screen reader users get the same words from the
 * bar's accessible name (`usagePaceLabel`).
 */
export function UsagePaceMark(props: {
  elapsedPercent: number;
  detail: string;
  className?: string;
}) {
  const left = Math.max(0, Math.min(100, props.elapsedPercent));
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-usage-pace-mark=""
            className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 flex h-4 w-3 items-center justify-center"
            style={{ left: `${left}%` }}
          />
        }
      >
        <span
          aria-hidden="true"
          className={cn("block h-2.5 w-0.5 rounded-full bg-foreground", props.className)}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">
        <p className="font-medium">{props.detail}</p>
        <p className="text-muted-foreground">Usage left of this line lasts until the reset</p>
      </TooltipPopup>
    </Tooltip>
  );
}

/** ", 44% of the week has passed", for a usage bar's accessible name. */
export function usagePaceLabel(detail: string | undefined): string {
  return detail === undefined ? "" : `, ${detail}`;
}
