import type { KeyboardEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Skeleton } from "./ui/skeleton";

export type DiffPanelMode = "inline" | "sheet" | "sidebar";

export function DiffPanelShell(props: {
  mode: DiffPanelMode;
  /** Omitted embedded in the right sidebar, where the tab strip is the header:
   *  a second bar there would only restate the tab that is already selected. */
  header?: ReactNode;
  children: ReactNode;
  onEscape?: (() => void) | undefined;
  /** Set when the panel renders under the right sidebar's tab strip, which
   *  already carries the drag region and the window-controls inset. */
  embedded?: boolean;
}) {
  const { embedded = false, onEscape } = props;
  const handleKeyDown =
    onEscape && props.mode !== "sheet"
      ? (event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key !== "Escape" || event.defaultPrevented) {
            return;
          }
          event.preventDefault();
          onEscape();
        }
      : undefined;

  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col bg-rail",
        props.mode === "inline"
          ? "w-[42vw] min-w-[360px] max-w-[560px] shrink-0 border-l border-border"
          : "w-full",
      )}
      onKeyDown={handleKeyDown}
    >
      {props.header ? (
        <div className={cn("shrink-0 border-b border-border", !embedded && "drag-region")}>
          <div
            className={cn(
              "@container/source-control-title flex items-center justify-between gap-2",
              embedded
                ? "h-9 px-3"
                : "h-12 px-4 py-2 wco:min-h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
            )}
          >
            {props.header}
          </div>
        </div>
      ) : null}
      {props.children}
    </div>
  );
}

/**
 * Placeholder rows in the shape of the list that is coming: one open file
 * with a run of lines, then a few closed ones. Bars only, no frame, so it
 * reads as the same edge-to-edge list before the data lands. The reveal is
 * held back a beat (see `.diff-panel-loading`) so a fast load never flashes it.
 */
const LOADING_ROWS: ReadonlyArray<{
  readonly path: string;
  readonly lines?: readonly string[];
}> = [
  { path: "w-44", lines: ["w-3/5", "w-2/5", "w-4/5", "w-1/3", "w-1/2", "w-3/4", "w-2/5"] },
  { path: "w-32" },
  { path: "w-52" },
  { path: "w-40" },
];

export function DiffPanelLoadingState(props: { label: string }) {
  return (
    <div
      className="diff-panel-loading min-h-0 flex-1 overflow-hidden"
      role="status"
      aria-live="polite"
      data-diff-panel-loading="true"
    >
      <span className="sr-only">{props.label}</span>
      {LOADING_ROWS.map((row, rowIndex) => (
        <div key={rowIndex} className="border-b border-border" aria-hidden="true">
          <div className="flex h-9 items-center gap-1.5 pl-1.5 pr-2">
            <Skeleton className="size-4 shrink-0" />
            <Skeleton className="size-4 shrink-0" />
            <Skeleton className={cn("h-2.5", row.path)} />
            <Skeleton className="ml-auto h-2.5 w-10 shrink-0" />
          </div>
          {row.lines ? (
            <div className="space-y-2.5 px-2 pt-1.5 pb-3">
              {row.lines.map((width, lineIndex) => (
                <div key={lineIndex} className="flex items-center gap-3">
                  <Skeleton className="h-2.5 w-7 shrink-0" />
                  <Skeleton className={cn("h-2.5", width)} />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
