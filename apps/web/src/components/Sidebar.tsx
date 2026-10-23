import { ChevronDownIcon, ChevronsUpIcon, CloudIcon, MonitorIcon, SearchIcon } from "lucide-react";
import React, { Suspense, useCallback, useEffect, memo, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ScopedThreadRef } from "@threadlines/contracts";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@threadlines/client-runtime";
import { useNavigate, useParams } from "@tanstack/react-router";
import { usePrimaryEnvironmentId } from "../environments/primary";
import type { ComputerLinkPendingRequest, EnvironmentId } from "@threadlines/contracts";
import { isTerminalFocused } from "../lib/terminalFocus";
import { cn, isMacPlatform, newCommandId } from "../lib/utils";
import { SIDEBAR_LIST_FIELD_CLASS } from "./sidebar/sidebarListField";
import { toSortableTimestamp } from "../lib/threadSort";
import { markThreadDoneByKey, reopenThreadByKey } from "../lib/threadInboxSync";
import { selectBootstrapCompleteForActiveEnvironment, useStore, type AppState } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useModelPickerOpen } from "../modelPickerOpenState";
import { useShortcutModifierState } from "../shortcutModifierState";
import { readLocalApi } from "../localApi";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { preserveRightPanelSearchParamsForDraftNavigation } from "../diffRouteSearch";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { type InboxEntry, useInboxThreads } from "../hooks/useInboxThreads";
import { useThreadMenu } from "../hooks/useThreadMenu";
import { useIsMobile } from "../hooks/useMediaQuery";

import {
  prewarmThreadJumpTargets,
  requestIdleThreadDetailPrewarm,
} from "../environments/runtime/service";
import { useThreadActions } from "../hooks/useThreadActions";
import { useThreadRowSwipes } from "../hooks/useThreadRowSwipes";
import { useInboxColumnLayout } from "../hooks/useInboxColumnLayout";
import { useLocalDayStartMs } from "../hooks/useLocalDayStartMs";
import {
  buildThreadRouteParams,
  resolveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Kbd } from "./ui/kbd";
import { ScrollArea } from "./ui/scroll-area";
import { Skeleton } from "./ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useCommandPaletteStore } from "../commandPaletteStore";
import {
  buildInboxSections,
  buildProjectScopeOptions,
  childThreadsHoverLine,
  countInboxRowAttention,
  familyParentKeyOf,
  getSidebarIdlePrewarmThreadIds,
  groupInboxLiveRows,
  inboxLiveRowHasAttention,
  inboxLiveRowHolds,
  inboxLiveRowHoldsOpenChild,
  inboxLiveRowThreadKeys,
  isNeedsUserStatus,
  labelWrappedRowsByDay,
  mergeThreadDoneOverride,
  resolveAdjacentThreadId,
  resolveInboxLiveFoldLimit,
  resolveScopedComposeTarget,
  resolveScopedProjectKeys,
  shouldClearThreadSelectionOnMouseDown,
  sortDoneThreads,
  sortInboxThreads,
  summarizeChildThreads,
  resolveRemoteFamilyChildren,
  toggleProjectScopeKey,
  windowInboxDoneRows,
  windowInboxThreads,
  wrappedDayGroupOf,
  useThreadJumpHintVisibility,
  WRAPPED_DAY_GROUP_LABELS,
  type InboxLiveRow,
  type InboxRemoteChild,
  type WrappedDayGroup,
} from "./Sidebar.logic";
import type { SidebarGrouping } from "@threadlines/contracts/settings";
import {
  InboxChildRow,
  InboxDoneRow,
  InboxLinkRequestRow,
  InboxRemoteChildRow,
  InboxThreadRow,
  type InboxThreadFamily,
  type RemoteParentLine,
} from "./sidebar/InboxRows";
import { useComputerLabel, usePendingLinkRequests } from "./sidebar/linkedComputers";
import type { ThreadHoverCardLineage } from "./sidebar/ThreadHoverCard";

import {
  countVisibleDraftSessions,
  SidebarDraftBlock,
  useFrozenOpenDraftRow,
  type SidebarDraftProjectInfo,
} from "./sidebar/SidebarDrafts";
import type { EnvironmentScopeOption } from "./sidebar/InboxViewMenu";
import { ProjectScopeMenu } from "./sidebar/ProjectScopeMenu";
import { SwipeUndoBar } from "./sidebar/SwipeUndoBar";
import { resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import { SidebarHoverCardGroup } from "./sidebar/hoverCard";
import { ThreadHoverCardProvider } from "./sidebar/ThreadHoverCard";
import { resolveThreadActionProjectRef, startNewGeneralChatThread } from "../lib/chatThreadActions";
import { SidebarDestinationRow, useSelectedDestination } from "./sidebar/NavigationRail";
import { AppWordmark } from "./sidebar/AppWordmark";
import { resolveShownDestinationList } from "./sidebar/destinationLists";
import { useListNewThreadStore } from "./sidebar/listNewThreadStore";
import { useGeneralChats } from "./chats/useGeneralChats";
import { AttentionCounts } from "./sidebar/AttentionCounts";
import { ProjectFavicon } from "./ProjectFavicon";
import { isRoom } from "../rooms";
import { type ThreadPullRequest } from "./pull-requests/pullRequests.logic";
import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";
import { SidebarVersionTag } from "./sidebar/SidebarVersionTag";
import { readEnvironmentApi } from "../environmentApi";
import { useRoomsEnabled } from "~/hooks/useRoomsEnabled";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "../rpc/serverState";

import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import type { SidebarThreadSummary } from "../types";

import { CommandDialogTrigger } from "./ui/command";

const EMPTY_THREAD_JUMP_LABELS = new Map<string, string>();
/** One empty list for every row with no linked pull requests, so it never reads as a change. */
const NO_PULL_REQUESTS: readonly ThreadPullRequest[] = [];
const NO_PROJECT_KEYS: readonly string[] = [];
/**
 * The fewest quiet live rows that rest unfolded; a column with room for more
 * shows as many as fit. Pinned rows and rows needing you are never folded.
 */
const LIVE_PREVIEW_COUNT = 10;
/**
 * A live row's height until one is measured: a list that opens with every
 * row in a folded group draws none to measure, and must still fill.
 */
const ESTIMATED_LIVE_ROW_PX = 48;
/** Each click on the reveal row uncovers this many more. */
const LIVE_REVEAL_STEP = 5;
/** The Done tail opens short and reveals in bigger steps: it is history. */
const DONE_PREVIEW_COUNT = 10;
const DONE_REVEAL_STEP = 20;
const SIDEBAR_LOADING_LIVE_ROW_WIDTHS = ["w-36", "w-28", "w-40"] as const;
const SIDEBAR_LOADING_WRAPPED_ROW_WIDTHS = ["w-32", "w-24"] as const;

function SidebarInboxLoadingSkeleton() {
  return (
    <div
      className="px-2 py-1"
      role="status"
      aria-label="Loading projects and threads"
      data-testid="sidebar-loading-skeleton"
    >
      {/* These are representative row shapes, not a prediction of the user's
          counts or activity. No status dot is drawn because that would make
          neutral loading rows look like work is already running. */}
      <div className="flex flex-col" data-testid="sidebar-loading-live-rows">
        {SIDEBAR_LOADING_LIVE_ROW_WIDTHS.map((width) => (
          <div key={width} className="relative w-full px-3 pt-1.5 pb-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <Skeleton className="size-3 shrink-0 rounded-sm" />
              <Skeleton className="h-2.5 w-16 rounded-full" />
              <Skeleton className="ml-auto h-2.5 w-10 rounded-full" />
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
              <Skeleton className={cn("h-3.5 rounded-full", width)} />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-2 px-3 pb-1.5">
        <Skeleton className="h-2.5 w-16 rounded-full" />
        <Skeleton className="h-px flex-1 rounded-none" />
        <Skeleton className="size-3.5 shrink-0 rounded-sm" />
      </div>
      <div className="flex flex-col" data-testid="sidebar-loading-wrapped-rows">
        {SIDEBAR_LOADING_WRAPPED_ROW_WIDTHS.map((width) => (
          <div key={width} className="flex items-center gap-2 px-3 py-1.5">
            <Skeleton className="size-3.5 shrink-0 rounded-sm" />
            <Skeleton className={cn("h-3.5 rounded-full", width)} />
            <Skeleton className="ml-auto h-2.5 w-8 shrink-0 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Thread refs from scoped thread keys joined by newlines. Prewarm effects
 * depend on the joined string, so a list that re-renders with the same rows
 * does not restart them.
 */
function threadRefsFromKeyList(keyList: string): ScopedThreadRef[] {
  return keyList.split("\n").flatMap((threadKey) => {
    const ref = threadKey ? parseScopedThreadKey(threadKey) : null;
    return ref ? [ref] : [];
  });
}

/** A run of live rows, under a group header while the inbox is grouped. */
interface InboxLiveSection {
  readonly group: {
    readonly key: string;
    readonly label: string;
    readonly icon: React.ReactNode;
    readonly needsYou: number;
    readonly working: number;
    readonly collapsed: boolean;
  } | null;
  readonly rows: readonly InboxLiveRow<InboxEntry>[];
}

/** Every parent without children on other computers shares this. */
const NO_REMOTE_CHILDREN: readonly InboxRemoteChild[] = [];

/**
 * The computers whose thread lists this app has: their threads speak for
 * themselves, so a parent's record of a child there stays out of its family.
 */
function selectEnvironmentIdsWithThreads(state: AppState): string[] {
  return Object.entries(state.environmentStateById).flatMap(([environmentId, environment]) =>
    environment.bootstrapComplete ? [environmentId] : [],
  );
}

function buildThreadJumpLabelMap(input: {
  keybindings: ReturnType<typeof useServerKeybindings>;
  platform: string;
  terminalOpen: boolean;
  threadJumpCommandByKey: ReadonlyMap<
    string,
    NonNullable<ReturnType<typeof threadJumpCommandForIndex>>
  >;
}): ReadonlyMap<string, string> {
  if (input.threadJumpCommandByKey.size === 0) {
    return EMPTY_THREAD_JUMP_LABELS;
  }

  const shortcutLabelOptions = {
    platform: input.platform,
    context: {
      terminalFocus: false,
      terminalOpen: input.terminalOpen,
    },
  } as const;
  const mapping = new Map<string, string>();
  for (const [threadKey, command] of input.threadJumpCommandByKey) {
    const label = shortcutLabelForCommand(input.keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(threadKey, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_THREAD_JUMP_LABELS;
}

/** The group a live row sits in while the inbox is grouped by project or computer. */
function inboxLiveGroupKey(
  grouping: Exclude<SidebarGrouping, "none">,
  row: { readonly entry: InboxEntry },
): string {
  return grouping === "project"
    ? `project:${row.entry.projectKey}`
    : `computer:${row.entry.thread.environmentId}`;
}

/**
 * The Wrapped shelf, parked at the foot of the inbox column: finished work
 * kept out of the way of the threads still going.
 *
 * Closed, it is one line (plus the row of a wrapped thread open in the
 * chat): a section's name, its count, how many wrapped today, then a hairline
 * running out to the chevron. The whole line is the control. Open, it rises
 * with its own scroll: as tall as its rows, and no taller than leaves the
 * live list room for all of its rows or half the column, whichever is more.
 * The live list above keeps its place and scrolls in what is left.
 */
function InboxWrappedShelf({
  open,
  count,
  todayCount,
  liveContentHeight,
  shelfRef,
  onToggle,
  foldLine,
  children,
}: {
  open: boolean;
  count: number;
  todayCount: number;
  /** See InboxColumnLayout.liveContentHeight. */
  liveContentHeight: number | null;
  shelfRef: (element: HTMLElement | null) => void;
  onToggle: () => void;
  /** The "Show N more…" line under the rows; open only. */
  foldLine: React.ReactNode;
  /** The rows: every shown one open, only the thread open in the chat closed. */
  children: React.ReactNode;
}) {
  return (
    <div
      ref={shelfRef}
      data-testid="inbox-wrapped-shelf"
      className="flex min-h-0 shrink-0 flex-col"
      style={
        open
          ? {
              maxHeight:
                liveContentHeight === null
                  ? "50%"
                  : `max(50%, calc(100% - ${liveContentHeight}px))`,
            }
          : undefined
      }
    >
      <button
        type="button"
        data-thread-selection-safe
        data-inbox-shelf-header
        data-testid="inbox-done-toggle"
        aria-expanded={open}
        className="group/section-header flex w-full shrink-0 cursor-pointer items-center gap-2 px-3 py-2 text-left select-none focus-ring"
        onClick={onToggle}
      >
        <span className="shrink-0 text-[11px] font-medium text-muted-foreground transition-colors group-hover/section-header:text-foreground">
          Wrapped ({count})
        </span>
        {/* Closed, the shelf still says what is fresh in it, by the same
          time its rows show: some threads wrap up on their own. */}
        {!open && todayCount > 0 ? (
          <span
            data-testid="inbox-done-today"
            className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
          >
            · {todayCount} today
          </span>
        ) : null}
        <span aria-hidden="true" className="h-px min-w-3 flex-1 bg-sidebar-border" />
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-150 group-hover/section-header:text-foreground",
            !open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <ScrollArea hideScrollbars className="h-auto min-h-0 flex-initial">
          {children}
          {foldLine}
        </ScrollArea>
      ) : (
        children
      )}
    </div>
  );
}

/** A day's label over the first of its rows in the open Wrapped shelf. */
function InboxWrappedDayLabel({ group }: { group: WrappedDayGroup }) {
  return (
    // The rows say their own times; the label only groups them for the eye.
    <li
      aria-hidden="true"
      data-testid="inbox-done-day"
      className="px-3 pt-2 pb-0.5 text-[10.5px] text-muted-foreground select-none"
    >
      {WRAPPED_DAY_GROUP_LABELS[group]}
    </li>
  );
}

/**
 * A group's header while the inbox is grouped by project or computer: what
 * the group is, what in it needs the user or is working, and the fold
 * chevron. The whole row folds the group. Not sticky: a group's rows
 * scroll away with it.
 */
function InboxGroupHeader({
  groupKey,
  label,
  icon,
  needsYou,
  working,
  collapsed,
  onToggleCollapsed,
}: {
  groupKey: string;
  label: string;
  icon: React.ReactNode;
  needsYou: number;
  working: number;
  collapsed: boolean;
  onToggleCollapsed: (groupKey: string) => void;
}) {
  return (
    // Padding, not the button's margin, spaces it: the column measures the
    // item's height as a header's whole footprint.
    <li className="list-none pt-1.5" data-inbox-group-header>
      <button
        type="button"
        data-thread-selection-safe
        data-testid={`inbox-group-${groupKey}`}
        aria-expanded={!collapsed}
        className="group/inbox-group flex w-full cursor-pointer items-center gap-1.5 px-3 pt-1 pb-1 text-left select-none focus-ring"
        onClick={() => onToggleCollapsed(groupKey)}
      >
        <span aria-hidden="true" className="flex size-3.5 shrink-0 items-center justify-center">
          {icon}
        </span>
        <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground transition-colors group-hover/inbox-group:text-foreground">
          {label}
        </span>
        <span className="ms-auto flex shrink-0">
          <AttentionCounts needsYou={needsYou} working={working} />
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-150 group-hover/inbox-group:text-foreground",
            collapsed && "-rotate-90",
          )}
        />
      </button>
    </li>
  );
}

/**
 * The phone sheet's top row: close the sheet, then the app's name. A wide
 * screen carries the name in the title row instead, and the list starts with
 * its search.
 */
const SidebarChromeHeader = memo(function SidebarChromeHeader() {
  return (
    <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-5 sm:py-3">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger
          className="size-7 shrink-0 text-muted-foreground/60 hover:text-foreground"
          tooltip="Collapse sidebar"
        />
        <AppWordmark />
      </div>
    </SidebarHeader>
  );
});

/**
 * The list's footer: the Intel-build warning, only while it has something to
 * say, so the footer is usually gone. The app's own version and updates live
 * in the rail's update button; where the rail is hidden (a phone, a narrow
 * window) the version tag stays here. Agent updates report in a notice.
 */
const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const isMobile = useIsMobile();
  return (
    <SidebarFooter className="p-2 empty:hidden">
      <SidebarUpdatePill />
      {isMobile ? (
        <div className="flex min-h-6 items-center justify-end px-1">
          <SidebarVersionTag />
        </div>
      ) : null}
    </SidebarFooter>
  );
});

/**
 * The sidebar is an inbox.
 *
 * One live list holding every thread that is still open, with deliberate pins
 * first and the rest following the user's thread sort preference. Below it,
 * the Done tail, ordered by when the work ended. Projects are a scope filter
 * across the top rather than a tree: every row names its own project, so
 * nothing has to be traced back to a group header.
 */
export default function Sidebar() {
  const {
    projects,
    sidebarThreads,
    sidebarProjects,
    sidebarProjectByKey,
    resolveProjectKeyForRef,
    generalChatProjectKeys,
    openPullRequests,
    pullRequestByThreadKey,
    linkedPullRequestsByThreadKey,
    entries,
  } = useInboxThreads();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const doneThreadOverlays = useUiStateStore((store) => store.doneThreadOverlays);
  const childThreadFamilyOpenById = useUiStateStore((store) => store.childThreadFamilyOpenById);
  const setChildThreadFamilyOpen = useUiStateStore((store) => store.setChildThreadFamilyOpen);
  const inboxProjectScopeKeys = useUiStateStore((store) => store.inboxProjectScopeKeys);
  const setInboxProjectScope = useUiStateStore((store) => store.setInboxProjectScope);
  const inboxEnvironmentScopeId = useUiStateStore((store) => store.inboxEnvironmentScopeId);
  const setInboxEnvironmentScope = useUiStateStore((store) => store.setInboxEnvironmentScope);
  const collapsedInboxGroups = useUiStateStore((store) => store.collapsedInboxGroups);
  const setInboxGroupCollapsed = useUiStateStore((store) => store.setInboxGroupCollapsed);
  const wrappedOpen = useUiStateStore((store) => store.inboxWrappedOpen);
  const setInboxWrappedOpen = useUiStateStore((store) => store.setInboxWrappedOpen);
  const navigate = useNavigate();
  const selectedDestination = useSelectedDestination();
  const sidebarGroupingSetting = useSettings((s) => s.sidebarGrouping);
  const { updateSettings } = useUpdateSettings();
  const roomsEnabled = useRoomsEnabled();
  // The Rooms filter (in the scope menu) narrows what the inbox shows, never
  // what the wrap-up rules read, so it can not change which threads get filed
  // away.
  const [roomsOnly, setRoomsOnly] = useState(false);
  const roomsFilterActive = roomsEnabled && roomsOnly;
  const appSettingsConfirmThreadArchive = useSettings<boolean>(
    (settings) => settings.confirmThreadArchive,
  );
  // The full hook (rather than `useNewThreadHandler`) because compose has to
  // resolve the same default project and draft context the app menu's "New
  // thread" action uses.
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const { archiveThread } = useThreadActions();
  const { isMobile, setOpenMobile } = useSidebar();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const keybindings = useServerKeybindings();
  const openAddProjectCommandPalette = useCommandPaletteStore((store) => store.openAddProject);
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const platform = navigator.platform;
  const shortcutModifiers = useShortcutModifierState();
  const modelPickerOpen = useModelPickerOpen();
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((s) => s.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((s) => s.byId);
  const computerLabel = useComputerLabel();
  const environmentIdsWithThreadsList = useStore(useShallow(selectEnvironmentIdsWithThreads));
  const environmentIdsWithThreads = useMemo(
    () => new Set<string>(environmentIdsWithThreadsList),
    [environmentIdsWithThreadsList],
  );
  const pendingLinkRequests = usePendingLinkRequests();
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [confirmingArchiveThreadKey, setConfirmingArchiveThreadKey] = useState<string | null>(null);
  const [revealedLiveCount, setRevealedLiveCount] = useState(0);
  const [revealedDoneCount, setRevealedDoneCount] = useState(0);
  const {
    liveContentHeight,
    liveRoomPx,
    plainRowPx,
    familyRowPx,
    localChildRowPx,
    remoteChildRowPx,
    groupHeaderPx,
    doneRowPx,
    columnRef: inboxColumnRef,
    liveContentRef: inboxLiveContentRef,
    shelfRef: wrappedShelfRef,
  } = useInboxColumnLayout();
  const todayStartMs = useLocalDayStartMs();
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const confirmArchiveButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const sidebarThreadByKey = useMemo(
    () =>
      new Map(
        sidebarThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [sidebarThreads],
  );
  // Callbacks read the latest map through a ref so they stay stable across
  // thread-list changes and never invalidate every row's memo.
  const sidebarThreadByKeyRef = useRef(sidebarThreadByKey);
  sidebarThreadByKeyRef.current = sidebarThreadByKey;

  const hasWorkspaceProjects = sidebarProjects.some((project) => project.kind !== "general-chat");
  // Until the first workspace snapshot arrives an empty list means "not loaded",
  // not "nothing here" — a paired phone would otherwise be told it has no
  // projects for the second before its projects appear.
  const bootstrapComplete = useStore(selectBootstrapCompleteForActiveEnvironment);

  // Every machine the inbox knows about: this device, plus whatever has been
  // added under Settings › Connections. Ordered with this device first, the rest by
  // name, so the list does not reshuffle as machines connect and drop.
  const environmentScopeOptions = useMemo<EnvironmentScopeOption[]>(() => {
    const resolveLabel = (environmentId: EnvironmentId, isPrimary: boolean) =>
      resolveEnvironmentOptionLabel({
        isPrimary,
        environmentId,
        runtimeLabel: savedEnvironmentRuntimeById[environmentId]?.descriptor?.label ?? null,
        savedLabel: savedEnvironmentRegistry[environmentId]?.label ?? null,
      });
    const savedOptions = Object.values(savedEnvironmentRegistry)
      .filter((record) => record.environmentId !== primaryEnvironmentId)
      .map((record) => ({
        environmentId: record.environmentId,
        label: resolveLabel(record.environmentId, false),
        isPrimary: false,
      }))
      .toSorted((left, right) => left.label.localeCompare(right.label));
    return primaryEnvironmentId === null
      ? savedOptions
      : [
          {
            environmentId: primaryEnvironmentId,
            label: resolveLabel(primaryEnvironmentId, true),
            isPrimary: true,
          },
          ...savedOptions,
        ];
  }, [primaryEnvironmentId, savedEnvironmentRegistry, savedEnvironmentRuntimeById]);
  // A machine that has been removed since the filter was set stops filtering,
  // rather than hiding the whole inbox behind a scope nothing can match.
  const scopedEnvironmentIdValue =
    inboxEnvironmentScopeId !== null &&
    environmentScopeOptions.length > 1 &&
    environmentScopeOptions.some((option) => option.environmentId === inboxEnvironmentScopeId)
      ? inboxEnvironmentScopeId
      : null;

  // Keyed by its joined text so the list keeps its identity while project
  // snapshots churn: every inbox memo below reads it.
  const scopedProjectKeyList = resolveScopedProjectKeys({
    pickedKeys: inboxProjectScopeKeys,
    projectByKey: sidebarProjectByKey,
    scopedEnvironmentId: scopedEnvironmentIdValue,
  }).join("\n");
  const scopedProjectKeys = useMemo(
    () => (scopedProjectKeyList === "" ? NO_PROJECT_KEYS : scopedProjectKeyList.split("\n")),
    [scopedProjectKeyList],
  );

  const machineScopedEntries = useMemo(
    () =>
      entries.filter(
        (entry) =>
          (scopedEnvironmentIdValue === null ||
            entry.thread.environmentId === scopedEnvironmentIdValue) &&
          (!roomsFilterActive || isRoom(entry.thread)),
      ),
    [entries, roomsFilterActive, scopedEnvironmentIdValue],
  );

  // Everything a draft row needs about its project, resolved once here: a
  // draft carries a scoped project ref, and the rows want the grouped display
  // name, the checkout the favicon comes from, and the logical key the inbox
  // scope filters on.
  const draftProjectInfoByScopedRef = useMemo(() => {
    const infoByScopedRef = new Map<string, SidebarDraftProjectInfo>();
    for (const project of projects) {
      const projectRef = scopeProjectRef(project.environmentId, project.id);
      const projectKey = resolveProjectKeyForRef(projectRef);
      infoByScopedRef.set(scopedProjectKey(projectRef), {
        projectKey,
        displayName: sidebarProjectByKey.get(projectKey)?.displayName ?? project.name,
        cwd: project.cwd,
        isGeneralChat: project.kind === "general-chat",
      });
    }
    return infoByScopedRef;
  }, [projects, resolveProjectKeyForRef, sidebarProjectByKey]);
  const routeDraftId = useParams({
    strict: false,
    select: (params) => {
      const target = resolveThreadRouteTarget(params);
      return target?.kind === "draft" ? target.draftId : null;
    },
  });
  // Only recaptured on route change, so it costs nothing per keystroke.
  const frozenOpenDraftRow = useFrozenOpenDraftRow(routeDraftId);
  // Count-only subscription: the sidebar needs "are there draft rows" for its
  // empty state, while SidebarDraftBlock owns the per-keystroke content
  // subscription. Selecting a number keeps typing in a draft composer from
  // re-rendering the whole sidebar; the count matches the block's rendered
  // rows exactly, so "No threads yet" stays up while a never-left draft is
  // being typed (it has no row to replace the text with).
  const visibleDraftSessionCount = useComposerDraftStore((store) =>
    countVisibleDraftSessions({
      store,
      projectInfoByScopedRef: draftProjectInfoByScopedRef,
      scopedProjectKeys,
      scopedEnvironmentId: scopedEnvironmentIdValue,
      routeDraftId,
      frozenOpenDraftRow,
    }),
  );

  const scopeOptions = useMemo(() => {
    const lastActivityMsByKey = new Map<string, number>();
    const needsYouCountByKey = new Map<string, number>();
    for (const entry of machineScopedEntries) {
      const activityAt =
        toSortableTimestamp(
          entry.thread.latestUserMessageAt ?? entry.thread.updatedAt ?? entry.thread.createdAt,
        ) ?? 0;
      lastActivityMsByKey.set(
        entry.projectKey,
        Math.max(lastActivityMsByKey.get(entry.projectKey) ?? 0, activityAt),
      );
      if (!entry.isDone && isNeedsUserStatus(entry.status)) {
        needsYouCountByKey.set(
          entry.projectKey,
          (needsYouCountByKey.get(entry.projectKey) ?? 0) + 1,
        );
      }
    }
    // A machine filter narrows the project list with it: offering a project
    // that has no checkout on the scoped machine could only produce an empty
    // intersection.
    return buildProjectScopeOptions({
      projects: sidebarProjects
        .filter((project) => project.kind !== "general-chat")
        .filter(
          (project) =>
            scopedEnvironmentIdValue === null ||
            project.memberProjects.some(
              (member) => member.environmentId === scopedEnvironmentIdValue,
            ),
        )
        .map((project) => ({ key: project.projectKey, label: project.displayName })),
      lastActivityMsByKey,
      needsYouCountByKey,
    });
  }, [machineScopedEntries, scopedEnvironmentIdValue, sidebarProjects]);

  // Families first: a parent's attached children travel with it through
  // every scope, and a family takes one row in the live list. A family can
  // span computers: a child on a computer the machine filter shows, under a
  // parent on one it hides, stands on its own instead.
  const { liveEntries, doneEntries } = useMemo(() => {
    const entryByThreadKey = new Map(entries.map((entry) => [entry.threadKey, entry] as const));
    const lookup = (thread: SidebarThreadSummary) =>
      entryByThreadKey.get(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))!;
    const scopedProjectKeySet = new Set(scopedProjectKeys);
    const inScope = (entry: InboxEntry) =>
      (scopedEnvironmentIdValue === null ||
        entry.thread.environmentId === scopedEnvironmentIdValue) &&
      (!roomsFilterActive || isRoom(entry.thread)) &&
      (scopedProjectKeySet.size === 0 || scopedProjectKeySet.has(entry.projectKey));
    const canSeeComputer = (environmentId: EnvironmentId) =>
      environmentIdsWithThreads.has(environmentId);
    const { live, done } = buildInboxSections({
      entries,
      parentKeyOf: (entry) => familyParentKeyOf(entry.thread),
      inScope,
      standsAlone: (child, parent) =>
        scopedEnvironmentIdValue !== null &&
        parent.thread.environmentId !== scopedEnvironmentIdValue &&
        inScope(child),
      remoteChildrenOf: (parent) =>
        (parent.thread.remoteChildren?.length ?? 0) +
          (parent.thread.remoteChildStarts?.length ?? 0) ===
        0
          ? NO_REMOTE_CHILDREN
          : resolveRemoteFamilyChildren({
              parent: parent.thread,
              canSeeComputer,
              computerLabel,
            }),
      isFamilyOpen: (parentKey) => childThreadFamilyOpenById[parentKey] === true,
      activeThreadKey: routeThreadKey,
      sortLive: (heads) => sortInboxThreads(heads.map((entry) => entry.thread)).map(lookup),
      sortDone: (heads) =>
        sortDoneThreads(
          heads.map((entry) => entry.thread),
          (thread) =>
            mergeThreadDoneOverride(
              doneThreadOverlays[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
              thread.doneOverride,
            ),
        ).map(lookup),
    });
    return { liveEntries: live, doneEntries: done };
  }, [
    childThreadFamilyOpenById,
    computerLabel,
    doneThreadOverlays,
    entries,
    environmentIdsWithThreads,
    roomsFilterActive,
    routeThreadKey,
    scopedEnvironmentIdValue,
    scopedProjectKeys,
  ]);

  // Grouping by computer needs a second computer to mean anything.
  const sidebarGrouping: SidebarGrouping =
    sidebarGroupingSetting === "computer" && environmentScopeOptions.length <= 1
      ? "none"
      : sidebarGroupingSetting;
  // What a closed Wrapped shelf keeps under its header: the thread open in
  // the chat, and the wrapped thread it sits under. The live list's fill
  // leaves room for it.
  const keptDoneRowCount = useMemo(
    () =>
      doneEntries.reduce(
        (count, row) =>
          count + (row.openChild !== null ? 2 : row.entry.threadKey === routeThreadKey ? 1 : 0),
        0,
      ),
    [doneEntries, routeThreadKey],
  );
  // Volume is managed by folding, not by flattening rows: quiet threads past
  // the limit fold away, and pins and anything with a status stay put. A
  // family takes one seat, and has a status when its parent or any live child
  // does. The limit fills the column, so it moves as the window resizes: the
  // row holding the thread open in the chat, or the one being renamed, never
  // folds away with it. The fill charges every row what it draws, priced by
  // its kind (heights the column remembers), never by what the fold shows.
  const liveFoldLimit = useMemo(() => {
    const plainPx = plainRowPx ?? familyRowPx ?? ESTIMATED_LIVE_ROW_PX;
    const familyPx = familyRowPx ?? plainPx;
    const localChildPx = localChildRowPx ?? remoteChildRowPx ?? plainPx;
    const remoteChildPx = remoteChildRowPx ?? localChildPx;
    return resolveInboxLiveFoldLimit({
      rows: liveEntries.map((row) => {
        const groupKey =
          sidebarGrouping === "none" ? null : inboxLiveGroupKey(sidebarGrouping, row);
        // A folded group draws its header and only the row holding the
        // thread open in the chat.
        const hiddenByGroup =
          groupKey !== null &&
          collapsedInboxGroups[groupKey] === true &&
          !inboxLiveRowHolds(row, routeThreadKey);
        const isFamily = row.children.length > 0 || row.remoteChildren.length > 0;
        return {
          pinned: row.entry.thread.pinnedAt !== null,
          alwaysShown:
            inboxLiveRowHasAttention(row) ||
            inboxLiveRowHolds(row, routeThreadKey) ||
            inboxLiveRowHolds(row, renamingThreadKey),
          costPx: hiddenByGroup ? 0 : isFamily ? familyPx : plainPx,
          childrenPx: hiddenByGroup
            ? 0
            : row.shownChildren.length * localChildPx +
              row.shownRemoteChildren.length * remoteChildPx,
          groupKey,
        };
      }),
      roomPx: liveRoomPx,
      groupHeaderPx: groupHeaderPx ?? 0,
      reservedPx: keptDoneRowCount * (doneRowPx ?? 0),
      minimum: LIVE_PREVIEW_COUNT,
    });
  }, [
    collapsedInboxGroups,
    doneRowPx,
    familyRowPx,
    groupHeaderPx,
    keptDoneRowCount,
    liveEntries,
    liveRoomPx,
    localChildRowPx,
    plainRowPx,
    remoteChildRowPx,
    renamingThreadKey,
    routeThreadKey,
    sidebarGrouping,
  ]);
  const { visible: visibleLiveEntries, hiddenCount: hiddenLiveCount } = useMemo(
    () =>
      windowInboxThreads({
        rows: liveEntries,
        hasAttention: (row) =>
          inboxLiveRowHasAttention(row) ||
          inboxLiveRowHolds(row, routeThreadKey) ||
          inboxLiveRowHolds(row, renamingThreadKey),
        isPinned: (row) => row.entry.thread.pinnedAt !== null,
        limit: liveFoldLimit + revealedLiveCount,
        expanded: false,
      }),
    [liveEntries, liveFoldLimit, renamingThreadKey, revealedLiveCount, routeThreadKey],
  );
  const nextLiveRevealCount = Math.min(LIVE_REVEAL_STEP, hiddenLiveCount);
  const visibleDoneEntries = useMemo(
    () => windowInboxDoneRows(doneEntries, DONE_PREVIEW_COUNT + revealedDoneCount, routeThreadKey),
    [doneEntries, revealedDoneCount, routeThreadKey],
  );
  const nextDoneRevealCount = Math.min(
    DONE_REVEAL_STEP,
    doneEntries.length - visibleDoneEntries.length,
  );
  // Closed, the shelf still holds the thread you are reading: closing a
  // section should not close the thing you have open in it.
  const renderedDoneEntries = useMemo(
    () =>
      wrappedOpen
        ? visibleDoneEntries
        : doneEntries.filter((row) => row.entry.threadKey === routeThreadKey || row.openChild),
    [doneEntries, routeThreadKey, visibleDoneEntries, wrappedOpen],
  );
  // Open, the shelf sorts its rows under days; closed, its header says how
  // many wrapped today, so a thread filed away on its own is not lost.
  const doneDayLabels = useMemo(
    () =>
      wrappedOpen
        ? labelWrappedRowsByDay(renderedDoneEntries, (row) => row.entry.doneAt, todayStartMs)
        : null,
    [renderedDoneEntries, todayStartMs, wrappedOpen],
  );
  const wrappedTodayCount = useMemo(
    () =>
      doneEntries.filter((row) => wrappedDayGroupOf(row.entry.doneAt, todayStartMs) === "today")
        .length,
    [doneEntries, todayStartMs],
  );
  // What a family's rows show: the parent's summary line, and the hover
  // cards' "Started by" and "Threads" lines.
  const familyByThreadKey = useMemo(() => {
    const byKey = new Map<string, InboxThreadFamily>();
    for (const row of liveEntries) {
      if (row.children.length === 0 && row.remoteChildren.length === 0) continue;
      byKey.set(row.entry.threadKey, {
        summary: summarizeChildThreads([...row.children, ...row.remoteChildren]),
        open: childThreadFamilyOpenById[row.entry.threadKey] === true,
      });
    }
    return byKey;
  }, [childThreadFamilyOpenById, liveEntries]);
  // Where a thread another computer's agent started came from: the parent's
  // title as this app has it (else as the thread was told), and its computer.
  const remoteParentOf = useCallback(
    (thread: SidebarThreadSummary): RemoteParentLine | null => {
      const remoteOrigin = thread.remoteOrigin ?? null;
      if (remoteOrigin === null) return null;
      return {
        title:
          sidebarThreadByKey.get(
            scopedThreadKey(scopeThreadRef(remoteOrigin.environmentId, remoteOrigin.threadId)),
          )?.title ?? remoteOrigin.threadTitle,
        computerLabel: computerLabel(remoteOrigin.environmentId, remoteOrigin.environmentLabel),
      };
    },
    [computerLabel, sidebarThreadByKey],
  );
  // A live row standing on its own that another computer's agent started
  // says so where its project name sits; nested, its parent row says it.
  const remoteParentByThreadKey = useMemo(() => {
    const byKey = new Map<string, RemoteParentLine>();
    for (const row of liveEntries) {
      const line = remoteParentOf(row.entry.thread);
      if (line !== null) byKey.set(row.entry.threadKey, line);
    }
    return byKey;
  }, [liveEntries, remoteParentOf]);
  const lineageByThreadKey = useMemo(() => {
    const byKey = new Map<string, ThreadHoverCardLineage>();
    const add = (
      entry: InboxEntry,
      children: readonly InboxEntry[],
      remoteChildren: readonly InboxRemoteChild[],
    ) => {
      const parentThreadId = entry.thread.parentThreadId ?? null;
      const remoteParent = remoteParentOf(entry.thread);
      const startedBy =
        remoteParent !== null
          ? `${remoteParent.title} on ${remoteParent.computerLabel}`
          : parentThreadId === null
            ? null
            : (sidebarThreadByKey.get(
                scopedThreadKey(scopeThreadRef(entry.thread.environmentId, parentThreadId)),
              )?.title ?? null);
      const threads =
        children.length === 0 && remoteChildren.length === 0
          ? null
          : childThreadsHoverLine(summarizeChildThreads([...children, ...remoteChildren]));
      if (startedBy !== null || threads !== null) {
        byKey.set(entry.threadKey, { startedBy, threads });
      }
    };
    for (const row of liveEntries) {
      add(row.entry, row.children, row.remoteChildren);
      for (const child of row.children) add(child, [], NO_REMOTE_CHILDREN);
    }
    for (const row of doneEntries) {
      add(row.entry, row.children, row.remoteChildren);
      if (row.openChild) add(row.openChild, [], NO_REMOTE_CHILDREN);
    }
    return byKey;
  }, [doneEntries, liveEntries, remoteParentOf, sidebarThreadByKey]);
  // The requests waiting for the user's Allow, on the computers the machine
  // filter shows: a request belongs to the computer it would run on.
  const shownLinkRequests = useMemo(
    () =>
      scopedEnvironmentIdValue === null
        ? pendingLinkRequests
        : pendingLinkRequests.filter(
            (pending) => pending.environmentId === scopedEnvironmentIdValue,
          ),
    [pendingLinkRequests, scopedEnvironmentIdValue],
  );
  const toggleChildThreadFamily = useCallback(
    (parentThreadKey: string) => {
      setChildThreadFamilyOpen(
        parentThreadKey,
        useUiStateStore.getState().childThreadFamilyOpenById[parentThreadKey] !== true,
      );
    },
    [setChildThreadFamilyOpen],
  );
  const toggleWrappedOpen = useCallback(() => {
    setInboxWrappedOpen(!useUiStateStore.getState().inboxWrappedOpen);
  }, [setInboxWrappedOpen]);

  // A new scope is a new list; the reveals from the old one mean nothing here.
  useEffect(() => {
    setRevealedLiveCount(0);
    setRevealedDoneCount(0);
  }, [scopedEnvironmentIdValue, scopedProjectKeyList]);

  // The live list as drawn: one section, or a section per project or
  // computer. Groups take the families as built (a family goes where its
  // parent goes) and the rows the fold left showing, in list order, so pins
  // still lead inside each group. A folded group keeps only the row holding
  // the thread open in the chat; its header still counts everything in it.
  const liveSections = useMemo((): readonly InboxLiveSection[] => {
    if (sidebarGrouping === "none") {
      return [{ group: null, rows: visibleLiveEntries }];
    }
    const groupKeyOf = (row: (typeof liveEntries)[number]) =>
      inboxLiveGroupKey(sidebarGrouping, row);
    const countsByKey = new Map(
      groupInboxLiveRows(liveEntries, groupKeyOf).map(
        (group) => [group.key, countInboxRowAttention(group.rows)] as const,
      ),
    );
    return groupInboxLiveRows(visibleLiveEntries, groupKeyOf).map((group) => {
      const first = group.rows[0]!.entry;
      const collapsed = collapsedInboxGroups[group.key] === true;
      const counts = countsByKey.get(group.key) ?? countInboxRowAttention(group.rows);
      let label: string;
      let icon: React.ReactNode;
      if (sidebarGrouping === "project") {
        const project = sidebarProjectByKey.get(first.projectKey);
        label = project?.displayName ?? first.projectLabel ?? "Project";
        icon = project ? (
          <ProjectFavicon
            cwd={project.cwd}
            environmentId={project.environmentId}
            name={project.displayName}
            className="size-3.5 shrink-0"
          />
        ) : null;
      } else {
        const machine = environmentScopeOptions.find(
          (option) => option.environmentId === first.thread.environmentId,
        );
        label = machine?.label ?? "Computer";
        const MachineIcon = machine?.isPrimary ? MonitorIcon : CloudIcon;
        icon = <MachineIcon className="size-3.5 text-muted-foreground" />;
      }
      return {
        group: {
          key: group.key,
          label,
          icon,
          needsYou: counts.needsYou,
          working: counts.working,
          collapsed,
        },
        rows: collapsed
          ? group.rows.filter(
              (row) =>
                row.entry.threadKey === routeThreadKey ||
                inboxLiveRowHoldsOpenChild(row, routeThreadKey),
            )
          : group.rows,
      };
    });
  }, [
    collapsedInboxGroups,
    environmentScopeOptions,
    liveEntries,
    routeThreadKey,
    sidebarGrouping,
    sidebarProjectByKey,
    visibleLiveEntries,
  ]);
  const toggleInboxGroup = useCallback(
    (groupKey: string) => {
      setInboxGroupCollapsed(
        groupKey,
        useUiStateStore.getState().collapsedInboxGroups[groupKey] !== true,
      );
    },
    [setInboxGroupCollapsed],
  );
  const handleGroupingChange = useCallback(
    (grouping: SidebarGrouping) => {
      updateSettings({ sidebarGrouping: grouping });
    },
    [updateSettings],
  );

  // Exactly the inbox rows drawn, in order: jump labels, shift-range
  // selection, previous/next and prewarming walk this list.
  const orderedThreadKeys = useMemo(
    () => [
      ...liveSections.flatMap((section) => section.rows.flatMap(inboxLiveRowThreadKeys)),
      ...renderedDoneEntries.flatMap((row) =>
        row.openChild ? [row.entry.threadKey, row.openChild.threadKey] : [row.entry.threadKey],
      ),
    ],
    [liveSections, renderedDoneEntries],
  );
  // The general chats in the General Chats list's order. They never join the
  // inbox, so while one is open previous/next walk these instead: chat to
  // chat, the way the list shows them.
  const { chats: generalChats } = useGeneralChats();
  const generalChatThreadKeys = useMemo(
    () =>
      generalChats.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    [generalChats],
  );
  const traversalThreadKeys =
    routeThreadKey !== null && generalChatThreadKeys.includes(routeThreadKey)
      ? generalChatThreadKeys
      : orderedThreadKeys;

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, navigate, setOpenMobile, setSelectionAnchor],
  );

  // A request opens where it can be read in full: the thread that asked, when
  // this app has it, else the Fleet page of the computer it would run on.
  const openLinkRequest = useCallback(
    (environmentId: EnvironmentId, request: ComputerLinkPendingRequest) => {
      const asking =
        useStore.getState().environmentStateById[request.parentEnvironmentId]?.threadShellById[
          request.parentThreadId
        ];
      if (asking !== undefined) {
        navigateToThread(scopeThreadRef(request.parentEnvironmentId, request.parentThreadId));
        return;
      }
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to: "/fleet/$environmentId", params: { environmentId } });
    },
    [isMobile, navigate, navigateToThread, setOpenMobile],
  );

  const navigateToDraft = useCallback(
    (draftId: DraftId) => {
      // Unconditional: also drops a stale selection anchor left by plain-click
      // navigation, so a later shift-click starts fresh instead of ranging from
      // a row that is no longer the context. (clearSelection no-ops when there
      // is nothing to clear.)
      clearSelection();
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({
        to: "/draft/$draftId",
        params: { draftId },
        search: preserveRightPanelSearchParamsForDraftNavigation,
      });
    },
    [clearSelection, isMobile, navigate, setOpenMobile],
  );

  const handleThreadClick = useCallback(
    (event: React.MouseEvent, threadRef: ScopedThreadRef, rowKeys: readonly string[]) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const threadKey = scopedThreadKey(threadRef);
      const currentSelectionCount = useThreadSelectionStore.getState().selectedThreadKeys.size;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadKey);
        return;
      }

      if (event.shiftKey) {
        event.preventDefault();
        rangeSelectTo(threadKey, rowKeys);
        return;
      }

      if (currentSelectionCount > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadKey);
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [
      clearSelection,
      isMobile,
      navigate,
      rangeSelectTo,
      setOpenMobile,
      setSelectionAnchor,
      toggleThreadSelection,
    ],
  );

  /**
   * The pull request badge. A plain click opens the thread's Pull request tab,
   * which is where the app can actually show it; a modifier or the middle
   * button is the browser's "open it somewhere else" gesture, and the host is
   * that somewhere else.
   */
  const openPrLink = useCallback(
    (
      event: React.MouseEvent<HTMLElement>,
      pullRequest: Pick<ThreadPullRequest, "number" | "url">,
      threadRef: ScopedThreadRef,
    ) => {
      event.preventDefault();
      event.stopPropagation();

      if (!(event.metaKey || event.ctrlKey || event.button === 1)) {
        if (isMobile) {
          setOpenMobile(false);
        }
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
          search: { pullRequest: "1", pullRequestNumber: pullRequest.number },
        });
        return;
      }

      const api = readLocalApi();
      if (!api) {
        toastManager.add({ type: "error", title: "Link opening is unavailable." });
        return;
      }

      void api.shell.openExternal(pullRequest.url).catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open pull request link",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      });
    },
    [isMobile, navigate, setOpenMobile],
  );

  const attemptArchiveThread = useCallback(
    async (threadRef: ScopedThreadRef) => {
      try {
        await archiveThread(threadRef);
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to archive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [archiveThread],
  );

  const markThreadDone = useCallback((threadKey: string) => {
    markThreadDoneByKey(threadKey);
  }, []);
  const reopenThread = useCallback((threadKey: string) => {
    reopenThreadByKey(threadKey);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingThreadKey(null);
    renamingInputRef.current = null;
  }, []);

  const commitRename = useCallback(
    async (threadRef: ScopedThreadRef, newTitle: string, originalTitle: string) => {
      const threadKey = scopedThreadKey(threadRef);
      const finishRename = () => {
        setRenamingThreadKey((current) => {
          if (current !== threadKey) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: threadRef.threadId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      finishRename();
    },
    [],
  );

  // The thread menu (useThreadMenu), the same one General chats and the
  // command palette offer. A row here renames in place, and the inbox says
  // whether it offers Wrap up or Reopen.
  const threadMenu = useThreadMenu();
  const inboxEntryByKey = useMemo(
    () => new Map(entries.map((entry) => [entry.threadKey, entry] as const)),
    [entries],
  );
  const inboxEntryByKeyRef = useRef(inboxEntryByKey);
  inboxEntryByKeyRef.current = inboxEntryByKey;
  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      await threadMenu.openSelection(
        threadKeys,
        position,
        (threadKey) => {
          const entry = inboxEntryByKeyRef.current.get(threadKey);
          return entry ? { isDone: entry.isDone, canMarkDone: entry.canMarkDone } : null;
        },
        () => {
          removeFromSelection(threadKeys);
          clearSelection();
        },
      );
    },
    [clearSelection, removeFromSelection, threadMenu],
  );

  const handleThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const threadKey = scopedThreadKey(threadRef);
      const entry = inboxEntryByKeyRef.current.get(threadKey);
      await threadMenu.open(
        {
          threadRef,
          inbox: entry ? { isDone: entry.isDone, canMarkDone: entry.canMarkDone } : null,
          renameInPlace: () => {
            const thread = sidebarThreadByKeyRef.current.get(threadKey);
            if (!thread) return;
            setRenamingThreadKey(threadKey);
            setRenamingTitle(thread.title);
            renamingCommittedRef.current = false;
          },
        },
        position,
      );
    },
    [threadMenu],
  );

  // A swipe on a row runs the menu's action of the same name; the two that
  // file a thread away without asking offer Undo (see useThreadRowSwipes).
  const { handleRowSwipe, swipeUndo, dismissSwipeUndo } = useThreadRowSwipes();

  // Compose follows the thread you are in, kept inside the scope while the
  // list is narrowed to projects (see resolveScopedComposeTarget).
  const handleComposeClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    const openProjectRef = resolveThreadActionProjectRef({
      activeDraftThread,
      activeThread,
      defaultProjectRef: null,
      handleNewThread,
    });
    const scopedTarget = resolveScopedComposeTarget({
      scopedProjectKeys,
      openProjectKey: openProjectRef === null ? null : resolveProjectKeyForRef(openProjectRef),
      projectByKey: sidebarProjectByKey,
      scopedEnvironmentId: scopedEnvironmentIdValue,
      primaryEnvironmentId,
    });
    const projectRef =
      scopedTarget.kind === "member"
        ? scopeProjectRef(scopedTarget.member.environmentId, scopedTarget.member.id)
        : (openProjectRef ?? defaultProjectRef);
    if (!projectRef) {
      return;
    }
    // General chats run in per-thread scratch directories; branch and worktree
    // seeding does not apply to them.
    if (generalChatProjectKeys.has(resolveProjectKeyForRef(projectRef))) {
      void startNewGeneralChatThread(handleNewThread, projectRef);
      return;
    }
    void handleNewThread(projectRef);
  }, [
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    generalChatProjectKeys,
    handleNewThread,
    isMobile,
    primaryEnvironmentId,
    resolveProjectKeyForRef,
    scopedEnvironmentIdValue,
    scopedProjectKeys,
    setOpenMobile,
    sidebarProjectByKey,
  ]);

  // The rail's New thread is this button on a wide screen, where the list
  // header no longer draws its own.
  const setListNewThread = useListNewThreadStore((store) => store.setStart);
  useEffect(() => {
    setListNewThread(handleComposeClick);
    return () => setListNewThread(null);
  }, [handleComposeClick, setListNewThread]);

  const handleScopeChange = useCallback(
    (projectKeys: readonly string[]) => {
      setInboxProjectScope(projectKeys);
      setRoomsOnly(false);
    },
    [setInboxProjectScope],
  );
  // Toggles against the scope in force, so a pick that has lapsed (a project
  // removed, or off the scoped machine) is not quietly revived by the next one.
  const handleToggleScopeProject = useCallback(
    (projectKey: string) => {
      handleScopeChange(toggleProjectScopeKey(scopedProjectKeys, projectKey));
    },
    [handleScopeChange, scopedProjectKeys],
  );

  const handleEnvironmentScopeChange = useCallback(
    (environmentId: string | null) => {
      setInboxEnvironmentScope(environmentId);
      setRoomsOnly(false);
    },
    [setInboxEnvironmentScope],
  );

  const getCurrentSidebarShortcutContext = useCallback(
    () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen: routeThreadRef
        ? selectThreadTerminalState(
            useTerminalStateStore.getState().terminalStateByThreadKey,
            routeThreadRef,
          ).terminalOpen
        : false,
      modelPickerOpen,
    }),
    [modelPickerOpen, routeThreadRef],
  );
  const shortcutLabelOptions = useMemo(
    () => ({
      platform,
      context: { terminalFocus: false, terminalOpen: false },
    }),
    [platform],
  );
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal", shortcutLabelOptions) ??
    shortcutLabelForCommand(keybindings, "chat.new", shortcutLabelOptions);
  const commandPaletteShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "commandPalette.toggle",
    shortcutLabelOptions,
  );

  const threadJumpCommandByKey = useMemo(() => {
    const mapping = new Map<string, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(threadKey, jumpCommand);
    }

    return mapping;
  }, [orderedThreadKeys]);
  const threadJumpThreadKeys = useMemo(
    () => [...threadJumpCommandByKey.keys()],
    [threadJumpCommandByKey],
  );
  const sidebarShortcutContext = useMemo(
    () => ({
      terminalFocus: false,
      terminalOpen: routeThreadRef
        ? selectThreadTerminalState(
            useTerminalStateStore.getState().terminalStateByThreadKey,
            routeThreadRef,
          ).terminalOpen
        : false,
      modelPickerOpen,
    }),
    [modelPickerOpen, routeThreadRef],
  );
  const threadJumpLabelByKey = useMemo(
    () =>
      buildThreadJumpLabelMap({
        keybindings,
        platform,
        terminalOpen: sidebarShortcutContext.terminalOpen,
        threadJumpCommandByKey,
      }),
    [keybindings, platform, sidebarShortcutContext.terminalOpen, threadJumpCommandByKey],
  );
  const shouldShowThreadJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    { platform, context: sidebarShortcutContext },
  );
  const visibleThreadJumpLabelByKey = showThreadJumpHints
    ? threadJumpLabelByKey
    : EMPTY_THREAD_JUMP_LABELS;

  // On a phone the sidebar is a sheet that mounts each time it opens, so it
  // prewarms nothing on its own there; rows still load on a touch.
  const idlePrewarmThreadKeyList = isMobile
    ? ""
    : getSidebarIdlePrewarmThreadIds({
        traversalThreadIds: orderedThreadKeys,
        activeThreadId: routeThreadKey,
      }).join("\n");
  useEffect(
    () => requestIdleThreadDetailPrewarm(threadRefsFromKeyList(idlePrewarmThreadKeyList)),
    [idlePrewarmThreadKeyList],
  );

  // While the jump numbers are on screen the user is about to press one.
  const threadJumpThreadKeyList = threadJumpThreadKeys.join("\n");
  useEffect(() => {
    if (!showThreadJumpHints) {
      return;
    }
    return prewarmThreadJumpTargets(threadRefsFromKeyList(threadJumpThreadKeyList));
  }, [showThreadJumpHints, threadJumpThreadKeyList]);

  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowThreadJumpHintsNow);
  }, [shouldShowThreadJumpHintsNow, updateThreadJumpHintsVisibility]);

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      const shortcutContext = getCurrentSidebarShortcutContext();

      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: shortcutContext,
      });
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        const targetThreadKey = resolveAdjacentThreadId({
          threadIds: traversalThreadKeys,
          currentThreadId: routeThreadKey,
          direction: traversalDirection,
        });
        if (!targetThreadKey) {
          return;
        }
        const targetThread = sidebarThreadByKey.get(targetThreadKey);
        if (!targetThread) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return;
      }

      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetThreadKey = threadJumpThreadKeys[jumpIndex];
      if (!targetThreadKey) {
        return;
      }
      const targetThread = sidebarThreadByKey.get(targetThreadKey);
      if (!targetThread) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
    };

    window.addEventListener("keydown", onWindowKeyDown);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    getCurrentSidebarShortcutContext,
    keybindings,
    navigateToThread,
    platform,
    routeThreadKey,
    sidebarThreadByKey,
    threadJumpThreadKeys,
    traversalThreadKeys,
  ]);

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (!useThreadSelectionStore.getState().hasSelection()) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection]);

  // What the list shows (see destinationLists). This component stays mounted
  // either way, so the thread shortcuts work on every page.
  const destinationList = resolveShownDestinationList(selectedDestination, isMobile);
  const PageListBody =
    destinationList !== null && destinationList.body !== "inbox" ? destinationList.body : null;

  return (
    <>
      {/* A phone has no title row and no rail: the sheet carries the name,
          and its destinations are a row under it. */}
      {isMobile ? <SidebarChromeHeader /> : null}
      {isMobile ? <SidebarDestinationRow /> : null}

      {PageListBody !== null ? (
        // A page with a list of its own (General chats, Computers, Settings)
        // on a wide screen; on a phone, only one whose list is in the sheet.
        <>
          {/* Holds the list's place while its code loads, so the footer stays put. */}
          <Suspense fallback={<div className="min-h-0 flex-1" />}>
            <PageListBody />
          </Suspense>
          {destinationList?.ownFooter ? null : (
            <>
              <SidebarSeparator />
              <SidebarChromeFooter />
            </>
          )}
        </>
      ) : destinationList === null ? null : (
        <>
          <SidebarHoverCardGroup>
            <ThreadHoverCardProvider>
              {/* Outside the scroll container: search and compose are chrome, and
                chrome does not scroll away. The list clips beneath the rule. */}
              <SidebarGroup className="shrink-0 bg-sidebar px-3 pt-3 pb-1">
                <CommandDialogTrigger
                  render={
                    <button
                      type="button"
                      data-testid="command-palette-trigger"
                      className={SIDEBAR_LIST_FIELD_CLASS}
                    />
                  }
                >
                  <SearchIcon className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate text-left text-xs">Search</span>
                  {commandPaletteShortcutLabel ? (
                    // Keyboard chrome means nothing to a touch pointer.
                    <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px] pointer-coarse:hidden">
                      {commandPaletteShortcutLabel}
                    </Kbd>
                  ) : null}
                </CommandDialogTrigger>
              </SidebarGroup>
              {/* No rule under the search: the boundary is the opaque chrome
                above and a short fade the rows pass into. The Wrapped shelf
                parks at the column's foot behind the same kind of fade; its
                header keeps its own hairline -- that one is a section rule. */}
              <div ref={inboxColumnRef} className="relative flex min-h-0 flex-1 flex-col">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 top-0 z-20 h-3 bg-linear-to-b from-sidebar to-transparent"
                />
                {/* The live list takes what the shelf leaves. The undo bar
                  floats over its foot, so it never covers the shelf. */}
                <div className="relative flex min-h-0 flex-1 flex-col">
                  <SidebarContent ref={inboxLiveContentRef} className="gap-0 pb-3">
                    <ProjectScopeMenu
                      options={scopeOptions}
                      projectByKey={sidebarProjectByKey}
                      scopedProjectKeys={scopedProjectKeys}
                      onScopeChange={handleScopeChange}
                      onToggleScopeProject={handleToggleScopeProject}
                      environmentOptions={environmentScopeOptions}
                      scopedEnvironmentId={scopedEnvironmentIdValue}
                      onEnvironmentScopeChange={handleEnvironmentScopeChange}
                      roomsOnly={roomsEnabled ? roomsOnly : null}
                      onRoomsOnlyChange={setRoomsOnly}
                      grouping={sidebarGrouping}
                      onGroupingChange={handleGroupingChange}
                      onAddProject={() => openAddProjectCommandPalette()}
                      onNewThread={isMobile ? handleComposeClick : null}
                      newThreadShortcutLabel={newThreadShortcutLabel}
                    />

                    {/* Threads another computer asked to start lead the list:
                      each waits for the user's Allow, and expires unanswered. */}
                    {shownLinkRequests.length > 0 ? (
                      <ul data-testid="inbox-link-requests">
                        {shownLinkRequests.map(({ environmentId, request }) => (
                          <InboxLinkRequestRow
                            key={`${environmentId}:${request.deviceId}:${request.requestId}`}
                            environmentId={environmentId}
                            computerLabel={computerLabel(environmentId, environmentId)}
                            askerLabel={computerLabel(
                              request.parentEnvironmentId,
                              request.fromLabel,
                            )}
                            request={request}
                            onOpen={() => openLinkRequest(environmentId, request)}
                          />
                        ))}
                      </ul>
                    ) : null}

                    {/* Unsent drafts sit above the inbox: an interrupted "new
                      thread" is the one row you want back in one click. */}
                    <SidebarDraftBlock
                      projectInfoByScopedRef={draftProjectInfoByScopedRef}
                      scopedProjectKeys={scopedProjectKeys}
                      scopedEnvironmentId={scopedEnvironmentIdValue}
                      routeDraftId={routeDraftId}
                      frozenOpenDraftRow={frozenOpenDraftRow}
                      onNavigateToDraft={navigateToDraft}
                    />

                    {liveEntries.length === 0 && visibleDraftSessionCount === 0 ? (
                      !bootstrapComplete ? (
                        <SidebarInboxLoadingSkeleton />
                      ) : (
                        <div className="flex flex-col items-start gap-1.5 px-3 py-2">
                          <span className="text-[11px] text-muted-foreground/60">
                            {!hasWorkspaceProjects
                              ? "No projects yet"
                              : roomsFilterActive
                                ? // Wrapped rooms may still list below, so
                                  // this speaks only for the active ones.
                                  "No active rooms"
                                : "No threads yet"}
                          </span>
                          {hasWorkspaceProjects ? null : (
                            <button
                              type="button"
                              data-testid="inbox-empty-add-project"
                              className="cursor-pointer text-[11px] text-muted-foreground/80 underline-offset-2 transition-colors hover:text-foreground hover:underline focus-ring"
                              onClick={() => openAddProjectCommandPalette()}
                            >
                              Add a project
                            </button>
                          )}
                        </div>
                      )
                    ) : (
                      <ul data-testid="inbox-thread-list" data-inbox-live-list>
                        {liveSections.map((section) => (
                          <React.Fragment key={section.group?.key ?? "inbox"}>
                            {section.group ? (
                              <InboxGroupHeader
                                groupKey={section.group.key}
                                label={section.group.label}
                                icon={section.group.icon}
                                needsYou={section.group.needsYou}
                                working={section.group.working}
                                collapsed={section.group.collapsed}
                                onToggleCollapsed={toggleInboxGroup}
                              />
                            ) : null}
                            {section.rows.map(
                              ({ entry, shownChildren, shownRemoteChildren, wrappedParent }) => (
                                <React.Fragment key={entry.threadKey}>
                                  <InboxThreadRow
                                    thread={entry.thread}
                                    status={entry.status}
                                    // A row names its project unless a project group's
                                    // header right above it already does. Scoped
                                    // to projects, it still names it: the menu that
                                    // says so is out of sight.
                                    projectLabel={
                                      sidebarGrouping !== "project" ? entry.projectLabel : null
                                    }
                                    // Under a project group's header the project's
                                    // mark is said once, there.
                                    showProjectMark={sidebarGrouping !== "project"}
                                    isActive={routeThreadKey === entry.threadKey}
                                    jumpLabel={
                                      visibleThreadJumpLabelByKey.get(entry.threadKey) ?? null
                                    }
                                    canMarkDone={entry.canMarkDone}
                                    orderedThreadKeys={orderedThreadKeys}
                                    renamingThreadKey={renamingThreadKey}
                                    renamingTitle={renamingTitle}
                                    setRenamingTitle={setRenamingTitle}
                                    renamingInputRef={renamingInputRef}
                                    renamingCommittedRef={renamingCommittedRef}
                                    handleThreadClick={handleThreadClick}
                                    navigateToThread={navigateToThread}
                                    handleMultiSelectContextMenu={handleMultiSelectContextMenu}
                                    handleThreadContextMenu={handleThreadContextMenu}
                                    clearSelection={clearSelection}
                                    commitRename={commitRename}
                                    cancelRename={cancelRename}
                                    markThreadDone={markThreadDone}
                                    listPullRequest={
                                      pullRequestByThreadKey.get(entry.threadKey) ?? null
                                    }
                                    linkedPullRequests={
                                      linkedPullRequestsByThreadKey.get(entry.threadKey) ??
                                      NO_PULL_REQUESTS
                                    }
                                    openPrLink={openPrLink}
                                    family={familyByThreadKey.get(entry.threadKey) ?? null}
                                    onToggleFamily={toggleChildThreadFamily}
                                    wrappedParentTitle={wrappedParent?.thread.title ?? null}
                                    remoteParent={
                                      remoteParentByThreadKey.get(entry.threadKey) ?? null
                                    }
                                    lineage={lineageByThreadKey.get(entry.threadKey)}
                                    onSwipeAction={handleRowSwipe}
                                  />
                                  {shownChildren.map((child) => (
                                    <InboxChildRow
                                      key={child.threadKey}
                                      thread={child.thread}
                                      status={child.status}
                                      isDone={child.isDone}
                                      doneAt={child.doneAt}
                                      isActive={routeThreadKey === child.threadKey}
                                      jumpLabel={
                                        visibleThreadJumpLabelByKey.get(child.threadKey) ?? null
                                      }
                                      canMarkDone={child.canMarkDone}
                                      orderedThreadKeys={orderedThreadKeys}
                                      renamingThreadKey={renamingThreadKey}
                                      renamingTitle={renamingTitle}
                                      setRenamingTitle={setRenamingTitle}
                                      renamingInputRef={renamingInputRef}
                                      renamingCommittedRef={renamingCommittedRef}
                                      handleThreadClick={handleThreadClick}
                                      navigateToThread={navigateToThread}
                                      handleMultiSelectContextMenu={handleMultiSelectContextMenu}
                                      handleThreadContextMenu={handleThreadContextMenu}
                                      clearSelection={clearSelection}
                                      commitRename={commitRename}
                                      cancelRename={cancelRename}
                                      markThreadDone={markThreadDone}
                                      reopenThread={reopenThread}
                                      lineage={lineageByThreadKey.get(child.threadKey)}
                                      onSwipeAction={handleRowSwipe}
                                      computerLabel={
                                        child.thread.environmentId === entry.thread.environmentId
                                          ? null
                                          : computerLabel(
                                              child.thread.environmentId,
                                              "another computer",
                                            )
                                      }
                                    />
                                  ))}
                                  {shownRemoteChildren.map((child) => (
                                    <InboxRemoteChildRow key={child.threadKey} child={child} />
                                  ))}
                                </React.Fragment>
                              ),
                            )}
                          </React.Fragment>
                        ))}
                      </ul>
                    )}

                    {hiddenLiveCount > 0 || revealedLiveCount > 0 ? (
                      <div className="flex items-center gap-1 px-3 pt-1 pb-1.5">
                        {nextLiveRevealCount > 0 ? (
                          <button
                            type="button"
                            data-thread-selection-safe
                            data-testid="inbox-live-show-more"
                            className="min-w-0 flex-1 cursor-pointer text-left text-[11px] text-muted-foreground/45 transition-colors hover:text-muted-foreground focus-ring"
                            onClick={() => {
                              setRevealedLiveCount((count) => count + nextLiveRevealCount);
                            }}
                          >
                            Show {nextLiveRevealCount} more…
                          </button>
                        ) : (
                          <span className="min-w-0 flex-1" aria-hidden="true" />
                        )}
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <CommandDialogTrigger
                                data-testid="inbox-live-search"
                                aria-label="Search threads"
                                className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/50 transition-colors hover:text-foreground focus-ring"
                              />
                            }
                          >
                            <SearchIcon className="size-3.5" />
                          </TooltipTrigger>
                          <TooltipPopup side="top">Search threads</TooltipPopup>
                        </Tooltip>
                        {revealedLiveCount > 0 ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  data-thread-selection-safe
                                  data-testid="inbox-live-show-fewer"
                                  aria-label="Show fewer threads"
                                  className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/50 transition-colors hover:text-foreground focus-ring"
                                  onClick={() => {
                                    setRevealedLiveCount(0);
                                  }}
                                />
                              }
                            >
                              <ChevronsUpIcon className="size-3.5" />
                            </TooltipTrigger>
                            <TooltipPopup side="top">Show fewer</TooltipPopup>
                          </Tooltip>
                        ) : null}
                      </div>
                    ) : null}
                  </SidebarContent>
                  {doneEntries.length > 0 ? (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-3 bg-linear-to-t from-sidebar to-transparent"
                    />
                  ) : null}
                  {swipeUndo ? (
                    <SwipeUndoBar
                      key={swipeUndo.id}
                      undo={swipeUndo}
                      onDismiss={dismissSwipeUndo}
                    />
                  ) : null}
                </div>
                {doneEntries.length > 0 ? (
                  <InboxWrappedShelf
                    open={wrappedOpen}
                    count={doneEntries.length}
                    todayCount={wrappedTodayCount}
                    liveContentHeight={liveContentHeight}
                    shelfRef={wrappedShelfRef}
                    onToggle={toggleWrappedOpen}
                    foldLine={
                      wrappedOpen && (nextDoneRevealCount > 0 || revealedDoneCount > 0) ? (
                        <div className="flex items-center gap-1 px-3 pt-2 pb-3">
                          {nextDoneRevealCount > 0 ? (
                            <button
                              type="button"
                              data-thread-selection-safe
                              data-testid="inbox-done-show-more"
                              className="min-w-0 flex-1 cursor-pointer text-left text-[11px] text-muted-foreground/45 transition-colors hover:text-muted-foreground focus-ring"
                              onClick={() => {
                                setRevealedDoneCount((current) => current + DONE_REVEAL_STEP);
                              }}
                            >
                              Show {nextDoneRevealCount} more…
                            </button>
                          ) : (
                            <span className="min-w-0 flex-1" aria-hidden="true" />
                          )}
                          {revealedDoneCount > 0 ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <button
                                    type="button"
                                    data-thread-selection-safe
                                    data-testid="inbox-done-show-fewer"
                                    aria-label="Show fewer wrapped threads"
                                    className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/50 transition-colors hover:text-foreground focus-ring"
                                    onClick={() => {
                                      setRevealedDoneCount(0);
                                    }}
                                  />
                                }
                              >
                                <ChevronsUpIcon className="size-3.5" />
                              </TooltipTrigger>
                              <TooltipPopup side="top">Show fewer</TooltipPopup>
                            </Tooltip>
                          ) : null}
                        </div>
                      ) : null
                    }
                  >
                    <ul data-testid="inbox-done-list">
                      {renderedDoneEntries.map(
                        ({ entry, children, remoteChildren, openChild }, index) => {
                          const dayGroup = doneDayLabels?.[index] ?? null;
                          return (
                            <React.Fragment key={entry.threadKey}>
                              {dayGroup !== null ? <InboxWrappedDayLabel group={dayGroup} /> : null}
                              <InboxDoneRow
                                thread={entry.thread}
                                projectLabel={entry.projectLabel}
                                doneAt={entry.doneAt}
                                isActive={routeThreadKey === entry.threadKey}
                                appSettingsConfirmThreadArchive={appSettingsConfirmThreadArchive}
                                confirmingArchiveThreadKey={confirmingArchiveThreadKey}
                                setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
                                confirmArchiveButtonRefs={confirmArchiveButtonRefs}
                                navigateToThread={navigateToThread}
                                handleThreadContextMenu={handleThreadContextMenu}
                                reopenThread={reopenThread}
                                attemptArchiveThread={attemptArchiveThread}
                                listPullRequest={
                                  pullRequestByThreadKey.get(entry.threadKey) ?? null
                                }
                                linkedPullRequests={
                                  linkedPullRequestsByThreadKey.get(entry.threadKey) ??
                                  NO_PULL_REQUESTS
                                }
                                openPrLink={openPrLink}
                                childCount={children.length + remoteChildren.length}
                                lineage={lineageByThreadKey.get(entry.threadKey)}
                                onSwipeAction={handleRowSwipe}
                              />
                              {/* Its wrapped threads live inside it; the one open
                                in the chat still shows where it is. */}
                              {openChild ? (
                                <InboxChildRow
                                  thread={openChild.thread}
                                  status={openChild.status}
                                  isDone
                                  doneAt={openChild.doneAt}
                                  isActive
                                  jumpLabel={
                                    visibleThreadJumpLabelByKey.get(openChild.threadKey) ?? null
                                  }
                                  canMarkDone={false}
                                  orderedThreadKeys={orderedThreadKeys}
                                  renamingThreadKey={renamingThreadKey}
                                  renamingTitle={renamingTitle}
                                  setRenamingTitle={setRenamingTitle}
                                  renamingInputRef={renamingInputRef}
                                  renamingCommittedRef={renamingCommittedRef}
                                  handleThreadClick={handleThreadClick}
                                  navigateToThread={navigateToThread}
                                  handleMultiSelectContextMenu={handleMultiSelectContextMenu}
                                  handleThreadContextMenu={handleThreadContextMenu}
                                  clearSelection={clearSelection}
                                  commitRename={commitRename}
                                  cancelRename={cancelRename}
                                  markThreadDone={markThreadDone}
                                  reopenThread={reopenThread}
                                  lineage={lineageByThreadKey.get(openChild.threadKey)}
                                  onSwipeAction={handleRowSwipe}
                                />
                              ) : null}
                            </React.Fragment>
                          );
                        },
                      )}
                    </ul>
                  </InboxWrappedShelf>
                ) : null}
              </div>
            </ThreadHoverCardProvider>
          </SidebarHoverCardGroup>

          <SidebarSeparator />
          <SidebarChromeFooter />
        </>
      )}
    </>
  );
}
