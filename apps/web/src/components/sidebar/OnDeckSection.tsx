import { PinIcon, XIcon } from "lucide-react";
import { memo, useCallback } from "react";
import type { ScopedThreadRef } from "@threadlines/contracts";
import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import type { SidebarThreadSummary } from "../../types";
import { cn } from "../../lib/utils";
import { resolveThreadRowClassName, type ThreadStatusPill } from "../Sidebar.logic";
import { ThreadStatusLabel } from "../ThreadStatusIndicators";
import { SectionLabel } from "../ui/threadline";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface OnDeckEntry {
  thread: SidebarThreadSummary;
  status: ThreadStatusPill | null;
  projectLabel: string | null;
  dismissible: boolean;
}

interface OnDeckRowProps {
  entry: OnDeckEntry;
  isActive: boolean;
  jumpLabel: string | null;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  dismissFromOnDeck: (threadKey: string) => void;
}

const ON_DECK_ROW_BUTTON_RENDER = <div role="button" tabIndex={0} />;

const OnDeckRow = memo(function OnDeckRow(props: OnDeckRowProps) {
  const { entry, isActive, jumpLabel, navigateToThread, dismissFromOnDeck } = props;
  const { thread, status, projectLabel, dismissible } = entry;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);

  const handleClick = useCallback(() => {
    navigateToThread(threadRef);
  }, [navigateToThread, threadRef]);
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      navigateToThread(threadRef);
    },
    [navigateToThread, threadRef],
  );
  const handleDismissClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      dismissFromOnDeck(threadKey);
    },
    [dismissFromOnDeck, threadKey],
  );
  const stopPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  return (
    <SidebarMenuItem className="w-full" data-thread-item>
      <SidebarMenuButton
        render={ON_DECK_ROW_BUTTON_RENDER}
        size="sm"
        isActive={isActive}
        data-testid={`on-deck-row-${thread.id}`}
        className={cn(
          resolveThreadRowClassName({ isActive, isSelected: false }),
          "relative isolate gap-1.5",
        )}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {status ? (
            <ThreadStatusLabel status={status} />
          ) : (
            <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          )}
        </span>
        {thread.pinnedAt !== null && (
          <span
            aria-label="Pinned thread"
            className="inline-flex h-4 shrink-0 items-center justify-center text-primary-readable"
          >
            <PinIcon className="size-3" />
          </span>
        )}
        <span
          className="min-w-0 flex-1 truncate text-xs"
          data-testid={`on-deck-title-${thread.id}`}
        >
          {thread.title}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {jumpLabel ? (
            <span
              className="inline-flex h-5 items-center rounded-full border border-border/80 bg-background/90 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm"
              title={jumpLabel}
            >
              {jumpLabel}
            </span>
          ) : null}
          {projectLabel ? (
            <span
              className={cn(
                "max-w-24 truncate font-mono text-[10px] text-muted-foreground/50",
                dismissible &&
                  "transition-opacity duration-150 group-hover/menu-item:opacity-0 group-focus-within/menu-item:opacity-0",
              )}
            >
              {projectLabel}
            </span>
          ) : null}
        </span>
        {dismissible && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-thread-selection-safe
                  data-testid={`on-deck-dismiss-${thread.id}`}
                  aria-label={`Remove ${thread.title} from On Deck`}
                  className="absolute top-1/2 right-1 inline-flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center text-muted-foreground/60 opacity-0 transition-opacity duration-150 group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:opacity-100"
                  onPointerDown={stopPointerDown}
                  onClick={handleDismissClick}
                >
                  <XIcon className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup side="top">Remove from On Deck</TooltipPopup>
          </Tooltip>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
});

export interface OnDeckSectionProps {
  entries: readonly OnDeckEntry[];
  routeThreadKey: string | null;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  dismissFromOnDeck: (threadKey: string) => void;
}

/**
 * The cross-project working set at the top of the sidebar. Rows keep their
 * insertion order — agent activity only changes the status dot, never the
 * position — so the threads being driven right now always live in the same
 * spot. The project tree below remains the browser for everything else.
 */
export const OnDeckSection = memo(function OnDeckSection(props: OnDeckSectionProps) {
  const { entries, routeThreadKey, threadJumpLabelByKey, navigateToThread, dismissFromOnDeck } =
    props;
  if (entries.length === 0) {
    return null;
  }

  return (
    <SidebarGroup className="px-2 pt-3 pb-1" data-testid="on-deck-section">
      <div className="mb-1 pl-2">
        <SectionLabel>On deck</SectionLabel>
      </div>
      <SidebarMenu>
        {entries.map((entry) => {
          const threadKey = scopedThreadKey(
            scopeThreadRef(entry.thread.environmentId, entry.thread.id),
          );
          return (
            <OnDeckRow
              key={threadKey}
              entry={entry}
              isActive={routeThreadKey === threadKey}
              jumpLabel={threadJumpLabelByKey.get(threadKey) ?? null}
              navigateToThread={navigateToThread}
              dismissFromOnDeck={dismissFromOnDeck}
            />
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
});
