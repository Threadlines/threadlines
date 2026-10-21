import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@threadlines/client-runtime";
import type { KeybindingCommand } from "@threadlines/contracts";
import { formatTokensCompact } from "@threadlines/shared/usageFormat";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import {
  ChartColumnIcon,
  GitPullRequestIcon,
  InboxIcon,
  type LucideIcon,
  MessagesSquareIcon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  SettingsIcon,
  SquarePenIcon,
  WaypointsIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { isElectron } from "../../env";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { startNewThreadFromContext } from "../../lib/chatThreadActions";
import {
  PULL_REQUEST_COUNT_REFETCH_INTERVAL_MS,
  usePullRequestLists,
} from "../../lib/pullRequestsReactQuery";
import { useThreadSeenSources } from "../../lib/threadInboxSync";
import { usageTodayQueryOptions, useUsageEnvironmentTargets } from "../../lib/usageReactQuery";
import { cn } from "../../lib/utils";
import { shortcutLabelForCommand } from "../../keybindings";
import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { useServerKeybindings } from "../../rpc/serverState";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { countNeedsYou } from "../pull-requests/pullRequests.logic";
import {
  countThreadAttention,
  resolveSeenThreadStatus,
  resolveThreadAttention,
  type ThreadAttention,
  type ThreadAttentionCounts,
} from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSidebar } from "../ui/sidebar";
import {
  NAVIGATION_DESTINATION_ORDER,
  type NavigationDestinationId,
  resolveSelectedDestination,
} from "./navigationRail.logic";

/** The rail's width; the thread list starts past it and slides away beneath it. */
export const NAVIGATION_RAIL_WIDTH_PX = 52;

const DESTINATION_LABELS: Record<NavigationDestinationId, string> = {
  threads: "Threads",
  chats: "General Chats",
  "pull-requests": "Pull Requests",
  fleet: "Fleet",
  usage: "Usage",
  settings: "Settings",
};

const DESTINATION_ICONS: Record<NavigationDestinationId, LucideIcon> = {
  threads: InboxIcon,
  chats: MessagesSquareIcon,
  "pull-requests": GitPullRequestIcon,
  fleet: WaypointsIcon,
  usage: ChartColumnIcon,
  settings: SettingsIcon,
};

const DESTINATION_SHORTCUTS: Partial<Record<NavigationDestinationId, KeybindingCommand>> = {
  fleet: "navigate.fleet",
};

/** One place the rail (or the phone's row of icons) can take the user. */
export interface NavigationDestination {
  readonly id: NavigationDestinationId;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly selected: boolean;
  /** Threads waiting on the user: an amber count on the icon. */
  readonly needsYou: number;
  /** Threads at work: a blue dot and count under the icon, while `showWorking`. */
  readonly working: number;
  readonly showWorking: boolean;
  readonly shortcutLabel: string | null;
  /** A short mono line in the tooltip ("3 working", "1.2M today"). */
  readonly detail: string | null;
}

/**
 * The last thread view (a thread, a draft or home) the user was on, so the
 * Threads button brings them back to it from Fleet or Usage. Kept for the
 * life of the window: on a fresh launch Threads opens home, which restores
 * the last thread itself.
 */
let lastThreadsViewHref: string | null = null;

/** Whether the thread or draft open in the main view is a general chat. */
function useOpenThreadIsGeneralChat(): boolean {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const draftId: DraftId | null = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  // Primitives only: a selector that builds an object reads as a new answer
  // on every store change, and React re-renders forever.
  const draftEnvironmentId = useComposerDraftStore((store) =>
    draftId === null ? null : (store.getDraftSession(draftId)?.environmentId ?? null),
  );
  const draftProjectId = useComposerDraftStore((store) =>
    draftId === null ? null : (store.getDraftSession(draftId)?.projectId ?? null),
  );
  const threadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  return useStore((state) => {
    const environmentId = threadRef?.environmentId ?? draftEnvironmentId;
    if (environmentId === null) return false;
    const environment = state.environmentStateById[environmentId];
    if (!environment) return false;
    const projectId =
      threadRef !== null
        ? environment.threadShellById[threadRef.threadId]?.projectId
        : draftProjectId;
    return (
      projectId !== undefined &&
      projectId !== null &&
      environment.projectById[projectId]?.kind === "general-chat"
    );
  });
}

/**
 * Remembers the thread view the user is on, for the Threads button. Mounted
 * once, with the app shell.
 */
export function useRememberThreadsView(): void {
  const href = useLocation({ select: (location) => location.href });
  const pathname = useLocation({ select: (location) => location.pathname });
  const openThreadIsGeneralChat = useOpenThreadIsGeneralChat();
  const onThreadsView =
    resolveSelectedDestination({ pathname, openThreadIsGeneralChat }) === "threads";
  useEffect(() => {
    if (onThreadsView) {
      lastThreadsViewHref = href;
    }
  }, [href, onThreadsView]);
}

/**
 * What the rail counts: threads needing the user and threads at work, for the
 * inbox and for general chats separately. Read off every connected computer,
 * above the inbox's project and machine filters.
 */
function useDestinationAttention(): {
  readonly threads: ThreadAttentionCounts;
  readonly chats: ThreadAttentionCounts;
} {
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const seenSources = useThreadSeenSources();
  return useMemo(() => {
    const generalChatProjectKeys = new Set(
      projects
        .filter((project) => project.kind === "general-chat")
        .map((project) => scopedProjectKey(scopeProjectRef(project.environmentId, project.id))),
    );
    const threadAttention: Array<ThreadAttention | null> = [];
    const chatAttention: Array<ThreadAttention | null> = [];
    for (const thread of threads) {
      if (thread.archivedAt !== null) continue;
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const { lastVisitedAt, status } = resolveSeenThreadStatus(thread, threadKey, seenSources);
      const attention = resolveThreadAttention(
        { ...thread, ...(lastVisitedAt !== undefined ? { lastVisitedAt } : {}) },
        status,
      );
      const isGeneralChat = generalChatProjectKeys.has(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      (isGeneralChat ? chatAttention : threadAttention).push(attention);
    }
    return {
      threads: countThreadAttention(threadAttention),
      chats: countThreadAttention(chatAttention),
    };
  }, [projects, seenSources, threads]);
}

function describeWorking(count: number): string | null {
  return count > 0 ? `${count} working` : null;
}

function describeNeedsYou(count: number): string | null {
  return count === 0 ? null : count === 1 ? "1 needs you" : `${count} need you`;
}

function joinDetails(...parts: Array<string | null>): string | null {
  const present = parts.filter((part): part is string => part !== null);
  return present.length > 0 ? present.join(" · ") : null;
}

/**
 * Every destination with what the rail says about it, and what choosing one
 * does. `listOpen` is whether the thread list beside the rail is showing: the
 * Threads icon carries the working count only while the list is hidden, since
 * the list says it otherwise.
 */
export function useNavigationDestinations(options: { readonly listOpen: boolean }): {
  readonly destinations: readonly NavigationDestination[];
  readonly select: (id: NavigationDestinationId) => void;
} {
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const openThreadIsGeneralChat = useOpenThreadIsGeneralChat();
  const selected = resolveSelectedDestination({ pathname, openThreadIsGeneralChat });
  const attention = useDestinationAttention();
  const keybindings = useServerKeybindings();
  // The same listing the inbox reads for its row badges: one poll for both.
  const openPullRequests = usePullRequestLists({
    state: "open",
    refetchIntervalMs: PULL_REQUEST_COUNT_REFETCH_INTERVAL_MS,
  });
  const usageTargets = useUsageEnvironmentTargets();
  const usageToday = useQuery(usageTodayQueryOptions({ targets: usageTargets }));
  const usageTokens = usageToday.data?.merged.totalTokens ?? null;
  const pullRequestsNeedingYou = countNeedsYou(openPullRequests.entries);
  const hasPullRequests = openPullRequests.environments.length > 0;

  const destinations = useMemo(() => {
    const platform = typeof navigator === "undefined" ? "" : navigator.platform;
    const shortcutOptions = { platform, context: { terminalFocus: false, terminalOpen: false } };
    const workingEverywhere = attention.threads.working + attention.chats.working;
    return NAVIGATION_DESTINATION_ORDER.flatMap((id): NavigationDestination[] => {
      // A destination that would only ever say "unsupported" is not offered.
      if (id === "pull-requests" && !hasPullRequests) return [];
      const command = DESTINATION_SHORTCUTS[id];
      const counts = id === "threads" ? attention.threads : id === "chats" ? attention.chats : null;
      return [
        {
          id,
          label: DESTINATION_LABELS[id],
          icon: DESTINATION_ICONS[id],
          selected: selected === id,
          needsYou: counts?.needsYou ?? 0,
          working: counts?.working ?? 0,
          // General chats have no list beside the rail, so their work always shows.
          showWorking: id === "chats" || (id === "threads" && !options.listOpen),
          shortcutLabel: command
            ? shortcutLabelForCommand(keybindings, command, shortcutOptions)
            : null,
          detail:
            id === "threads" || id === "chats"
              ? joinDetails(
                  describeNeedsYou(counts?.needsYou ?? 0),
                  describeWorking(counts?.working ?? 0),
                )
              : id === "fleet"
                ? describeWorking(workingEverywhere)
                : id === "pull-requests"
                  ? describeNeedsYou(pullRequestsNeedingYou)
                  : id === "usage" && usageTokens !== null
                    ? `${formatTokensCompact(usageTokens)} today`
                    : null,
        },
      ];
    });
  }, [
    attention,
    hasPullRequests,
    keybindings,
    options.listOpen,
    pullRequestsNeedingYou,
    selected,
    usageTokens,
  ]);

  const { open, setOpen, isMobile } = useSidebar();
  const select = useCallback(
    (id: NavigationDestinationId) => {
      switch (id) {
        case "threads": {
          if (selected === "threads") {
            // Already there: the button's job is to show the list.
            if (!isMobile && !open) setOpen(true);
            return;
          }
          if (lastThreadsViewHref !== null) {
            void router.navigate({ href: lastThreadsViewHref });
            return;
          }
          void navigate({ to: "/" });
          return;
        }
        case "chats":
          void navigate({ to: "/chats" });
          return;
        case "pull-requests":
          void navigate({ to: "/pull-requests", search: { state: "open" } });
          return;
        case "fleet":
          void navigate({ to: "/fleet" });
          return;
        case "usage":
          void navigate({ to: "/usage" });
          return;
        case "settings":
          void navigate({ to: "/settings" });
          return;
      }
    },
    [isMobile, navigate, open, router, selected, setOpen],
  );

  return { destinations, select };
}

/** The amber count of threads waiting on the user, on an icon's corner. */
function NeedsYouBadge({ count }: { readonly count: number }) {
  if (count === 0) return null;
  return (
    <span
      aria-hidden="true"
      data-testid="rail-needs-you-badge"
      className="pointer-events-none absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 font-mono text-[10px] leading-none font-semibold text-white tabular-nums"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** A plain toolbar button for the rail: no fill until hover, a soft fill while selected. */
function RailIconButton({
  label,
  tooltip,
  selected = false,
  side,
  onClick,
  children,
  testId,
  className,
}: {
  readonly label: string;
  readonly tooltip: ReactNode;
  readonly selected?: boolean;
  readonly side: "right" | "bottom";
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly testId?: string;
  readonly className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-current={selected ? "page" : undefined}
            data-testid={testId}
            data-selected={selected ? "" : undefined}
            className={cn(
              "relative inline-flex size-[34px] shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors select-none focus-ring [-webkit-app-region:no-drag] [&_svg]:size-4",
              selected
                ? "bg-sidebar-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
              className,
            )}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side={side} sideOffset={6}>
        {tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}

function DestinationTooltip({ destination }: { readonly destination: NavigationDestination }) {
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <span>{destination.label}</span>
      {destination.detail ? (
        <span
          className={cn(
            "font-mono text-[10.5px]",
            destination.needsYou > 0
              ? "text-amber-600 dark:text-amber-300/90"
              : "text-primary-readable",
          )}
        >
          {destination.detail}
        </span>
      ) : null}
      {destination.shortcutLabel ? (
        <span className="font-mono text-[10.5px] text-muted-foreground">
          {destination.shortcutLabel}
        </span>
      ) : null}
    </span>
  );
}

/** A destination's button, with its counts. */
function DestinationButton({
  destination,
  side,
  onSelect,
}: {
  readonly destination: NavigationDestination;
  readonly side: "right" | "bottom";
  readonly onSelect: (id: NavigationDestinationId) => void;
}) {
  const Icon = destination.icon;
  const working = destination.showWorking ? destination.working : 0;
  return (
    <div className="flex flex-col items-center">
      <RailIconButton
        label={destination.label}
        tooltip={<DestinationTooltip destination={destination} />}
        selected={destination.selected}
        side={side}
        testId={`rail-${destination.id}`}
        onClick={() => onSelect(destination.id)}
      >
        <Icon aria-hidden="true" />
        <NeedsYouBadge count={destination.needsYou} />
      </RailIconButton>
      {working > 0 ? (
        <span
          data-testid={`rail-${destination.id}-working`}
          className="mt-0.5 flex h-3 items-center gap-1 font-mono text-[10px] leading-none text-muted-foreground tabular-nums"
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-primary-graph" />
          {working}
          <span className="sr-only"> working</span>
        </span>
      ) : null}
    </div>
  );
}

/**
 * The column of destinations at the window's left edge on wide screens:
 * Threads, General Chats, Pull Requests, Fleet and Usage, Settings at the
 * bottom. It stays when the thread list beside it is hidden, so what needs
 * the user is always one glance away. The list's toggle sits at its top,
 * and a New thread button joins it while the list is hidden.
 */
export function NavigationRail() {
  const { open, toggleSidebar } = useSidebar();
  const { destinations, select } = useNavigationDestinations({ listOpen: open });
  const keybindings = useServerKeybindings();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const shortcutOptions = { platform, context: { terminalFocus: false, terminalOpen: false } };
  const toggleShortcut = shortcutLabelForCommand(keybindings, "sidebar.toggle", shortcutOptions);
  const newThreadShortcut =
    shortcutLabelForCommand(keybindings, "chat.newLocal", shortcutOptions) ??
    shortcutLabelForCommand(keybindings, "chat.new", shortcutOptions);
  const main = destinations.filter((destination) => destination.id !== "settings");
  const settings = destinations.find((destination) => destination.id === "settings") ?? null;

  return (
    <nav
      aria-label="Main"
      data-slot="navigation-rail"
      data-testid="navigation-rail"
      className="relative z-20 hidden w-(--sidebar-rail-width) shrink-0 flex-col items-center border-r border-border bg-[var(--app-chrome-background)] pb-3 md:flex"
    >
      {/* Window controls own this strip on macOS (the traffic lights reach
          over the rail); it is empty, and moves the window. */}
      <div
        aria-hidden="true"
        className="drag-region h-(--sidebar-rail-top-inset) w-full shrink-0"
      />
      <div
        className={cn(
          "flex h-(--workspace-topbar-height) w-full shrink-0 items-center justify-center",
          isElectron && "drag-region",
        )}
      >
        <RailIconButton
          label={open ? "Hide sidebar" : "Show sidebar"}
          testId="rail-sidebar-toggle"
          side="right"
          tooltip={
            <span className="flex items-center gap-2 whitespace-nowrap">
              {open ? "Hide sidebar" : "Show sidebar"}
              {toggleShortcut ? (
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  {toggleShortcut}
                </span>
              ) : null}
            </span>
          }
          onClick={toggleSidebar}
        >
          {open ? <PanelLeftCloseIcon aria-hidden="true" /> : <PanelLeftIcon aria-hidden="true" />}
        </RailIconButton>
      </div>
      {open ? null : (
        <RailIconButton
          label="New thread"
          testId="rail-new-thread"
          side="right"
          tooltip={
            <span className="flex items-center gap-2 whitespace-nowrap">
              New thread
              {newThreadShortcut ? (
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  {newThreadShortcut}
                </span>
              ) : null}
            </span>
          }
          onClick={() => {
            void startNewThreadFromContext({
              activeDraftThread,
              activeThread,
              defaultProjectRef,
              handleNewThread,
            });
          }}
        >
          <SquarePenIcon aria-hidden="true" />
        </RailIconButton>
      )}
      <span aria-hidden="true" className="my-2 h-px w-6 shrink-0 bg-border" />
      <div className="flex flex-col items-center gap-1.5">
        {main.map((destination) => (
          <DestinationButton
            key={destination.id}
            destination={destination}
            side="right"
            onSelect={select}
          />
        ))}
      </div>
      <div className="min-h-3 flex-1" />
      {settings ? (
        <DestinationButton destination={settings} side="right" onSelect={select} />
      ) : null}
    </nav>
  );
}

/**
 * The rail's destinations on a phone: one row of the same icons under the
 * sheet's header. Choosing one closes the sheet.
 */
export function SidebarDestinationRow() {
  const { setOpenMobile } = useSidebar();
  // The list is the sheet itself here, so the Threads icon never carries the
  // working count it would show beside a hidden list.
  const { destinations, select } = useNavigationDestinations({ listOpen: true });
  const onSelect = useCallback(
    (id: NavigationDestinationId) => {
      setOpenMobile(false);
      select(id);
    },
    [select, setOpenMobile],
  );
  const main = destinations.filter((destination) => destination.id !== "settings");
  const settings = destinations.find((destination) => destination.id === "settings") ?? null;
  return (
    <nav
      aria-label="Main"
      data-testid="sidebar-destination-row"
      className="flex shrink-0 items-start gap-1 px-2 pb-2"
    >
      {main.map((destination) => (
        <DestinationButton
          key={destination.id}
          destination={destination}
          side="bottom"
          onSelect={onSelect}
        />
      ))}
      {settings ? (
        <div className="ms-auto">
          <DestinationButton destination={settings} side="bottom" onSelect={onSelect} />
        </div>
      ) : null}
    </nav>
  );
}
