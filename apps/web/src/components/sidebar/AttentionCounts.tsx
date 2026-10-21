import { cn } from "../../lib/utils";
import { THREAD_STATUS_DOT_CLASSES } from "../Sidebar.logic";

/**
 * What waits on the user and what is at work, as dots and numbers in the
 * rail's colors (amber, blue): the name beside it keeps the room a narrow
 * list has. Says nothing when both are zero.
 */
export function AttentionCounts({
  needsYou,
  working,
  className,
}: {
  readonly needsYou: number;
  readonly working: number;
  readonly className?: string;
}) {
  if (needsYou === 0 && working === 0) return null;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-2 font-mono text-[10px] text-muted-foreground tabular-nums",
        className,
      )}
    >
      {needsYou > 0 ? (
        <span
          className="flex items-center gap-1"
          title={needsYou === 1 ? "1 needs you" : `${needsYou} need you`}
        >
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full", THREAD_STATUS_DOT_CLASSES.amber)}
          />
          {needsYou}
          <span className="sr-only">{needsYou === 1 ? " needs you" : " need you"}</span>
        </span>
      ) : null}
      {working > 0 ? (
        <span className="flex items-center gap-1" title={`${working} working`}>
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full", THREAD_STATUS_DOT_CLASSES.blue)}
          />
          {working}
          <span className="sr-only"> working</span>
        </span>
      ) : null}
    </span>
  );
}
