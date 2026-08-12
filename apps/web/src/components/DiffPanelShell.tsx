import type { KeyboardEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";

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
 * Waiting for the diff says so in one line, on the panel's gutter. It used to be
 * a framed pane of skeleton bars, which drew a whole fake document over a delay
 * that is usually shorter than reading the word "loading" -- and made the panel
 * look like an embedded app rather than a sidebar.
 */
export function DiffPanelLoadingState(props: { label: string }) {
  return (
    <div
      className="min-h-0 flex-1 px-3 py-2 text-[12px] text-muted-foreground/55"
      role="status"
      aria-live="polite"
      data-diff-panel-loading="true"
    >
      {props.label}
    </div>
  );
}
