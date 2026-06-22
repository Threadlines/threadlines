import type { KeyboardEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Skeleton } from "./ui/skeleton";

export type DiffPanelMode = "inline" | "sheet" | "sidebar";

export function DiffPanelShell(props: {
  mode: DiffPanelMode;
  header: ReactNode;
  children: ReactNode;
  onEscape?: (() => void) | undefined;
}) {
  const { onEscape } = props;
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
      <div className="drag-region shrink-0 border-b border-border">
        <div className="@container/source-control-title flex h-12 items-center justify-between gap-2 px-4 py-2 wco:min-h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
          {props.header}
        </div>
      </div>
      {props.children}
    </div>
  );
}

export function DiffPanelHeaderSkeleton() {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <Skeleton className="size-3.5 shrink-0 rounded-sm" />
      <Skeleton className="h-3 w-32 rounded-full" />
    </div>
  );
}

export function DiffPanelLoadingState(props: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-2">
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/60 bg-card/25"
        role="status"
        aria-live="polite"
        aria-label={props.label}
      >
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
          <Skeleton className="h-4 w-32 rounded-full" />
          <Skeleton className="ml-auto h-4 w-20 rounded-full" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-3 py-4">
          <div className="space-y-2">
            <Skeleton className="h-3 w-full rounded-full" />
            <Skeleton className="h-3 w-full rounded-full" />
            <Skeleton className="h-3 w-10/12 rounded-full" />
            <Skeleton className="h-3 w-11/12 rounded-full" />
            <Skeleton className="h-3 w-9/12 rounded-full" />
          </div>
          <span className="sr-only">{props.label}</span>
        </div>
      </div>
    </div>
  );
}
