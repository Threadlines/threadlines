import { BellDotIcon, SearchIcon, SettingsIcon, SquarePenIcon } from "lucide-react";
import { memo, useCallback } from "react";
import type { ScopedThreadRef } from "@threadlines/contracts";
import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import { cn } from "../../lib/utils";
import { countThreadsNeedingUser, isNeedsUserStatus } from "../Sidebar.logic";
import { ThreadStatusDot } from "../ThreadStatusIndicators";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { OnDeckEntry } from "./OnDeckSection";
import type { SidebarDestination } from "./DestinationBand";
import { ThreadHoverCard, ThreadHoverCardGroup } from "./ThreadHoverCard";

const RAIL_BUTTON_CLASS_NAME =
  "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/70 outline-hidden ring-ring transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2";

interface RailButtonProps {
  label: string;
  onClick: () => void;
  testId?: string;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}

function RailButton({
  label,
  onClick,
  testId,
  active = false,
  disabled = false,
  children,
}: RailButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            data-testid={testId}
            disabled={disabled}
            className={cn(
              RAIL_BUTTON_CLASS_NAME,
              active && "bg-sidebar-accent text-foreground",
              disabled && "cursor-default opacity-40 hover:bg-transparent hover:text-inherit",
            )}
            onClick={onClick}
          >
            {children}
          </button>
        }
      />
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

export interface DeckRailProps {
  entries: readonly OnDeckEntry[];
  destinations: readonly SidebarDestination[];
  routeThreadKey: string | null;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  openSearch: () => void;
  openSettings: () => void;
  startNewThread: () => void;
  expandSidebar: () => void;
}

/**
 * The collapsed density of the left sidebar. Titles and the project tree are
 * dropped; what survives is the question the sidebar answers while you are
 * heads-down in one thread — is anything else running, finished, or stuck?
 * On Deck rows keep their expanded order so a dot never moves under the
 * cursor, and the aggregate "needs you" badge stands in for the per-row
 * attention signal that collapsing takes away.
 */
export const DeckRail = memo(function DeckRail(props: DeckRailProps) {
  const {
    entries,
    destinations,
    routeThreadKey,
    navigateToThread,
    openSearch,
    openSettings,
    startNewThread,
    expandSidebar,
  } = props;
  const needsUserCount = countThreadsNeedingUser(entries.map((entry) => entry.status));

  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center gap-1 py-2"
      data-testid="sidebar-deck-rail"
    >
      <RailButton label="New thread" onClick={startNewThread} testId="deck-rail-new-thread">
        <SquarePenIcon className="size-4" />
      </RailButton>
      <RailButton label="Search" onClick={openSearch} testId="deck-rail-search">
        <SearchIcon className="size-4" />
      </RailButton>
      {destinations.length > 0 ? (
        <>
          <div className="my-1 w-5 border-border border-t" role="separator" />
          {destinations.map((destination) => {
            const Icon = destination.icon;
            return (
              <RailButton
                key={destination.id}
                label={destination.label}
                onClick={destination.onSelect}
                testId={`deck-rail-destination-${destination.id}`}
                active={destination.active}
                disabled={destination.disabled ?? false}
              >
                <Icon className="size-4" />
              </RailButton>
            );
          })}
        </>
      ) : null}
      {needsUserCount > 0 ? (
        <RailButton
          label={`${needsUserCount} ${needsUserCount === 1 ? "thread needs" : "threads need"} you`}
          onClick={expandSidebar}
          testId="deck-rail-needs-you"
        >
          <span className="relative inline-flex">
            <BellDotIcon className="size-4 text-amber-600 dark:text-amber-300/90" />
            <span className="-top-1 -right-1.5 absolute inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-1 font-mono text-[9px] text-background leading-none dark:bg-amber-300/90">
              {needsUserCount}
            </span>
          </span>
        </RailButton>
      ) : null}

      {entries.length > 0 ? (
        <>
          <div className="my-1 w-5 border-border border-t" role="separator" />
          <ThreadHoverCardGroup>
            <div className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto">
              {entries.map((entry) => (
                <DeckRailThread
                  key={scopedThreadKey(scopeThreadRef(entry.thread.environmentId, entry.thread.id))}
                  entry={entry}
                  routeThreadKey={routeThreadKey}
                  navigateToThread={navigateToThread}
                />
              ))}
            </div>
          </ThreadHoverCardGroup>
        </>
      ) : null}

      <div className="flex-1" />
      <RailButton label="Settings" onClick={openSettings} testId="deck-rail-settings">
        <SettingsIcon className="size-4" />
      </RailButton>
    </div>
  );
});

function DeckRailThread(props: {
  entry: OnDeckEntry;
  routeThreadKey: string | null;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
}) {
  const { entry, routeThreadKey, navigateToThread } = props;
  const threadRef = scopeThreadRef(entry.thread.environmentId, entry.thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const isActive = routeThreadKey === threadKey;
  const handleClick = useCallback(() => {
    navigateToThread(threadRef);
  }, [navigateToThread, threadRef]);

  return (
    <ThreadHoverCard thread={entry.thread} status={entry.status} side="right">
      <button
        type="button"
        aria-label={entry.thread.title}
        aria-current={isActive ? "true" : undefined}
        data-testid={`deck-rail-thread-${entry.thread.id}`}
        className={cn(
          RAIL_BUTTON_CLASS_NAME,
          "relative",
          isActive && "bg-sidebar-accent",
          isNeedsUserStatus(entry.status) &&
            "after:absolute after:inset-y-1 after:-left-0.5 after:w-0.5 after:rounded-full after:bg-amber-500 dark:after:bg-amber-300/90",
        )}
        onClick={handleClick}
      >
        <ThreadStatusDot status={entry.status} />
      </button>
    </ThreadHoverCard>
  );
}
