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
  CalendarClockIcon,
  ChartColumnIcon,
  GitPullRequestIcon,
  InboxIcon,
  type LucideIcon,
  MessagesSquareIcon,
  SettingsIcon,
  SquarePenIcon,
  WaypointsIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { startNewThreadFromContext } from "../../lib/chatThreadActions";
import {
  PULL_REQUEST_COUNT_REFETCH_INTERVAL_MS,
  usePullRequestLists,
} from "../../lib/pullRequestsReactQuery";
import { useThreadSeenSources } from "../../lib/threadInboxSync";
import { usageTodayQueryOptions, useUsageEnvironmentTargets } from "../../lib/usageReactQuery";
import {
  describeActiveScheduledTasks,
  useScheduledTaskEnvironments,
  useScheduledTasksStore,
} from "../../lib/scheduledTasksState";
import { isElectron } from "../../env";
import { cn, isMacPlatform } from "../../lib/utils";
import { shortcutLabelForCommand } from "../../keybindings";
import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { useServerKeybindings } from "../../rpc/serverState";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { resolveThreadRouteRef, resolveThreadRouteTarget } from "../../threadRoutes";
import { countNeedsYou } from "../pull-requests/pullRequests.logic";
import {
  countThreadAttention,
  isUnreadResultStatus,
  resolveSeenThreadStatus,
  resolveThreadAttention,
  THREAD_STATUS_DOT_CLASSES,
  type ThreadAttention,
  type ThreadAttentionCounts,
} from "../Sidebar.logic";
import { ChromeIconButton, ChromeTooltip } from "./ChromeIconButton";
import { useListNewThreadStore } from "./listNewThreadStore";
import { RailUpdateButton } from "./RailUpdateButton";
import { useSidebar } from "../ui/sidebar";
import {
  NAVIGATION_DESTINATION_LABELS,
  NAVIGATION_DESTINATION_ORDER,
  type NavigationDestinationId,
  resolveSelectedDestination,
} from "./navigationRail.logic";

/** The rail's width: a 34px button and its margins. */
export const NAVIGATION_RAIL_WIDTH_PX = 48;

const DESTINATION_ICONS: Record<NavigationDestinationId, LucideIcon> = {
  threads: InboxIcon,
  chats: MessagesSquareIcon,
  "pull-requests": GitPullRequestIcon,
  fleet: WaypointsIcon,
  scheduled: CalendarClockIcon,
  usage: ChartColumnIcon,
  settings: SettingsIcon,
};

const DESTINATION_SHORTCUTS: Partial<Record<NavigationDestinationId, KeybindingCommand>> = {
  fleet: "navigate.fleet",
  scheduled: "navigate.scheduled",
};

/** One place the rail (or the phone's row of icons) can take the user. */
export interface NavigationDestination {
  readonly id: NavigationDestinationId;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly selected: boolean;
  /** Threads waiting on the user: an amber count on the icon. */
  readonly needsYou: number;
  /**
   * General chats only: a result nobody has looked at yet (a finished turn, a
   * ready plan). A blue dot beside the count, since chats have no list here
   * to show it.
   */
  readonly unread: boolean;
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

/**
 * What the main view has open: no thread (home, a page), a thread or draft
 * in a project, a general chat, or a thread whose project this app hasn't
 * loaded yet (a chat just created, before its shell arrives).
 */
type OpenThreadKind = "none" | "project" | "general-chat" | "unknown";

function useOpenThreadKind(): OpenThreadKind {
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
  return useStore((state): OpenThreadKind => {
    if (routeTarget === null || routeTarget === undefined) return "none";
    const environmentId = threadRef?.environmentId ?? draftEnvironmentId;
    if (environmentId === null) return "unknown";
    const environment = state.environmentStateById[environmentId];
    if (!environment) return "unknown";
    const projectId =
      threadRef !== null
        ? environment.threadShellById[threadRef.threadId]?.projectId
        : draftProjectId;
    const project =
      projectId === undefined || projectId === null
        ? undefined
        : environment.projectById[projectId];
    if (!project) return "unknown";
    return project.kind === "general-chat" ? "general-chat" : "project";
  });
}

/** The destination on screen: what the rail shows selected, and whose list is beside it. */
export function useSelectedDestination(): NavigationDestinationId {
  const pathname = useLocation({ select: (location) => location.pathname });
  const openThreadIsGeneralChat = useOpenThreadKind() === "general-chat";
  return resolveSelectedDestination({ pathname, openThreadIsGeneralChat });
}

/**
 * The shortcut context the main view is in, for the labels the rail shows:
 * whether the open thread's terminal is showing, as the shortcut handlers
 * read it. Focus is never in a terminal while the pointer is on the rail.
 */
export function useRouteShortcutContext(): {
  readonly terminalFocus: boolean;
  readonly terminalOpen: boolean;
} {
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  return useMemo(() => ({ terminalFocus: false, terminalOpen }), [terminalOpen]);
}

/** Where a thread view lives: the thread's or draft's own path, or home. */
function threadViewPathOf(target: ReturnType<typeof resolveThreadRouteTarget>): string {
  if (target?.kind === "server") {
    return `/${target.threadRef.environmentId}/${target.threadRef.threadId}`;
  }
  if (target?.kind === "draft") return `/draft/${target.draftId}`;
  return "/";
}

/**
 * Remembers the thread view the user is on, for the Threads button. Mounted
 * once, with the app shell.
 */
export function useRememberThreadsView(): void {
  const href = useLocation({ select: (location) => location.href });
  const pathname = useLocation({ select: (location) => location.pathname });
  // The path the open thread or draft lives at; "/" for home.
  const threadViewPath = useParams({
    strict: false,
    select: (params) => threadViewPathOf(resolveThreadRouteTarget(params)),
  });
  const onThreadsView = useSelectedDestination() === "threads";
  const openThread = useOpenThreadKind();
  useEffect(() => {
    // While a navigation settles, the address can already be the next page's
    // while the open thread is still the last one's, and a thread whose
    // project hasn't loaded reads as Threads for a moment. Either way a
    // general chat could become the Threads button's target, so only an
    // address that matches a known thread view is remembered.
    if (onThreadsView && openThread !== "unknown" && pathname === threadViewPath) {
      lastThreadsViewHref = href;
    }
  }, [href, onThreadsView, openThread, pathname, threadViewPath]);
}

/**
 * What the rail counts: threads needing the user and threads at work, for the
 * inbox and for general chats separately. Read off every connected computer,
 * above the inbox's project and machine filters.
 */
function useDestinationAttention(): {
  readonly threads: ThreadAttentionCounts;
  readonly chats: ThreadAttentionCounts;
  /** Whether any general chat holds a result nobody has seen. */
  readonly chatsUnread: boolean;
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
    let chatsUnread = false;
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
      if (isGeneralChat && isUnreadResultStatus(status)) chatsUnread = true;
    }
    return {
      threads: countThreadAttention(threadAttention),
      chats: countThreadAttention(chatAttention),
      chatsUnread,
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
  const selected = useSelectedDestination();
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
  const scheduledEnvironments = useScheduledTaskEnvironments();
  const hasScheduledTasks = scheduledEnvironments.length > 0;
  const scheduledSummary = useScheduledTasksStore((state) =>
    describeActiveScheduledTasks(state.byEnvironment),
  );
  const shortcutContext = useRouteShortcutContext();

  const destinations = useMemo(() => {
    const platform = typeof navigator === "undefined" ? "" : navigator.platform;
    const shortcutOptions = { platform, context: shortcutContext };
    const workingEverywhere = attention.threads.working + attention.chats.working;
    return NAVIGATION_DESTINATION_ORDER.flatMap((id): NavigationDestination[] => {
      // A destination that would only ever say "unsupported" is not offered.
      if (id === "pull-requests" && !hasPullRequests) return [];
      // Hidden until a connected computer's server runs scheduled tasks.
      if (id === "scheduled" && !hasScheduledTasks) return [];
      const command = DESTINATION_SHORTCUTS[id];
      const counts = id === "threads" ? attention.threads : id === "chats" ? attention.chats : null;
      return [
        {
          id,
          label: NAVIGATION_DESTINATION_LABELS[id],
          icon: DESTINATION_ICONS[id],
          selected: selected === id,
          needsYou: id === "pull-requests" ? pullRequestsNeedingYou : (counts?.needsYou ?? 0),
          unread: id === "chats" && attention.chatsUnread,
          working: counts?.working ?? 0,
          // General chats have no list beside the rail, so their work always shows.
          showWorking: id === "chats" || (id === "threads" && !options.listOpen),
          shortcutLabel: command
            ? shortcutLabelForCommand(keybindings, command, shortcutOptions)
            : // Settings opens from the desktop app's own menu shortcut.
              id === "settings" && isElectron
              ? isMacPlatform(platform)
                ? "⌘,"
                : "Ctrl+,"
              : null,
          detail:
            id === "threads" || id === "chats"
              ? joinDetails(
                  describeNeedsYou(counts?.needsYou ?? 0),
                  describeWorking(counts?.working ?? 0),
                  id === "chats" && attention.chatsUnread ? "unread" : null,
                )
              : id === "fleet"
                ? describeWorking(workingEverywhere)
                : id === "scheduled"
                  ? scheduledSummary
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
    hasScheduledTasks,
    keybindings,
    options.listOpen,
    pullRequestsNeedingYou,
    scheduledSummary,
    selected,
    shortcutContext,
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
        case "scheduled":
          void navigate({ to: "/scheduled" });
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

/**
 * An icon's corner: the amber count of what waits on the user, and beside it
 * a blue dot for a result nobody has seen. Dark text on the amber, which
 * white could not read against.
 */
function CornerMarks({
  needsYou,
  unread,
}: {
  readonly needsYou: number;
  readonly unread: boolean;
}) {
  if (needsYou === 0 && !unread) return null;
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -top-1 -right-1 flex items-center gap-0.5"
    >
      {unread ? (
        <span
          data-testid="rail-unread-dot"
          className={cn("size-2 rounded-full", THREAD_STATUS_DOT_CLASSES.blue)}
        />
      ) : null}
      {needsYou > 0 ? (
        <span
          data-testid="rail-needs-you-badge"
          className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 font-mono text-[10px] leading-none font-semibold text-amber-950 tabular-nums"
        >
          {needsYou > 99 ? "99+" : needsYou}
        </span>
      ) : null}
    </span>
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
  glide = false,
  onSelect,
}: {
  readonly destination: NavigationDestination;
  readonly side: "right" | "bottom";
  /** In the rail: the rail's sliding highlight marks the selection. */
  readonly glide?: boolean;
  readonly onSelect: (id: NavigationDestinationId) => void;
}) {
  const Icon = destination.icon;
  const working = destination.showWorking ? destination.working : 0;
  // The corner marks are drawn for the eye; the name says them for a reader.
  const label = [
    destination.label,
    destination.needsYou > 0 ? describeNeedsYou(destination.needsYou) : null,
    destination.unread ? "unread" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  return (
    <div className="flex flex-col items-center">
      <ChromeIconButton
        size="rail"
        label={label}
        tooltip={<DestinationTooltip destination={destination} />}
        selected={destination.selected}
        glide={glide}
        side={side}
        testId={`rail-${destination.id}`}
        onClick={() => onSelect(destination.id)}
      >
        <Icon aria-hidden="true" />
        <CornerMarks needsYou={destination.needsYou} unread={destination.unread} />
      </ChromeIconButton>
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
 * The column at the window's left edge on wide screens, on the frame's own
 * color: New thread first, then Threads, General Chats, Pull Requests, Fleet
 * and Usage, Settings at the bottom. Nothing in it moves when the list
 * beside it hides or shows, so what needs the user is always one glance
 * away. A phone has no rail: its sheet carries a row of the same buttons.
 */
/**
 * The rail's selection: one soft fill that slides to the selected button (a
 * transform, so the rail never repaints for it). The first placement, and any
 * after nothing was selected, snaps into place instead of sweeping in from the
 * top. It re-measures when the rail resizes or its buttons change (a working
 * count appearing, the update button showing), so it never sits on a stale
 * spot.
 */
function RailSelectionHighlight({
  rail,
  selectedKey,
}: {
  // The element itself, not a ref: a child's layout effect runs before its
  // parent's ref is attached, so a ref would still be empty on the first pass.
  readonly rail: HTMLElement | null;
  readonly selectedKey: string | null;
}) {
  const [place, setPlace] = useState<{ readonly y: number; readonly animate: boolean } | null>(
    null,
  );
  useLayoutEffect(() => {
    if (!rail) return;
    const measure = () => {
      const target = rail.querySelector<HTMLElement>("[data-glide][data-selected]");
      if (!target) {
        setPlace(null);
        return;
      }
      const y = Math.round(target.getBoundingClientRect().top - rail.getBoundingClientRect().top);
      setPlace((current) =>
        current !== null && current.y === y ? current : { y, animate: current !== null },
      );
    };
    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(rail);
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(rail, { childList: true, subtree: true });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [rail, selectedKey]);
  if (place === null) return null;
  return (
    <span
      aria-hidden="true"
      data-testid="rail-selection"
      className={cn(
        "pointer-events-none absolute top-0 left-[7px] size-[34px] rounded-lg bg-sidebar-accent",
        place.animate &&
          "transition-transform duration-[220ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none",
      )}
      style={{ transform: `translateY(${place.y}px)` }}
    />
  );
}

export function NavigationRail() {
  const { open, isMobile } = useSidebar();
  const { destinations, select } = useNavigationDestinations({ listOpen: open });
  const [railElement, setRailElement] = useState<HTMLElement | null>(null);
  const keybindings = useServerKeybindings();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  // The thread list's own New thread, which starts in the project the list
  // is narrowed to; the open thread's project while the list is not there.
  const listNewThread = useListNewThreadStore((store) => store.start);
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const shortcutOptions = { platform, context: useRouteShortcutContext() };
  const newThreadShortcut =
    shortcutLabelForCommand(keybindings, "chat.newLocal", shortcutOptions) ??
    shortcutLabelForCommand(keybindings, "chat.new", shortcutOptions);
  if (isMobile) return null;
  const main = destinations.filter((destination) => destination.id !== "settings");
  const settings = destinations.find((destination) => destination.id === "settings") ?? null;
  const selectedKey = destinations.find((destination) => destination.selected)?.id ?? null;

  return (
    <nav
      ref={setRailElement}
      aria-label="Main"
      data-slot="navigation-rail"
      data-testid="navigation-rail"
      className="relative z-20 flex w-(--app-rail-width) shrink-0 flex-col items-center gap-1 bg-frame pt-3 pb-2"
    >
      <RailSelectionHighlight rail={railElement} selectedKey={selectedKey} />
      <ChromeIconButton
        size="rail"
        label="New thread"
        testId="new-thread-button"
        side="right"
        tooltip={<ChromeTooltip label="New thread" shortcut={newThreadShortcut} />}
        onClick={() => {
          if (listNewThread) {
            listNewThread();
            return;
          }
          void startNewThreadFromContext({
            activeDraftThread,
            activeThread,
            defaultProjectRef,
            handleNewThread,
          });
        }}
      >
        <SquarePenIcon aria-hidden="true" />
      </ChromeIconButton>
      <span aria-hidden="true" className="my-1 h-px w-5 shrink-0 bg-border" />
      {main.map((destination) => (
        <DestinationButton
          key={destination.id}
          destination={destination}
          side="right"
          glide
          onSelect={select}
        />
      ))}
      <div className="min-h-2 flex-1" />
      <RailUpdateButton />
      {settings ? (
        <DestinationButton destination={settings} side="right" glide onSelect={select} />
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
