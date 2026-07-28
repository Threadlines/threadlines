import { MessagesSquareIcon, SearchIcon, SettingsIcon, SquarePenIcon } from "lucide-react";
import { ThreadlinesGlyph } from "./Icons";
import { SectionLabel } from "./ui/threadline";
import React, { useCallback, useEffect, memo, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadEnvMode,
  ThreadId,
} from "@threadlines/contracts";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@threadlines/client-runtime";
import { Link, useLocation, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { isElectron } from "../env";
import { APP_BASE_NAME, APP_STAGE_LABEL, APP_VERSION } from "../branding";
import { isTerminalFocused } from "../lib/terminalFocus";
import { cn, isMacPlatform, newCommandId } from "../lib/utils";
import { toSortableTimestamp } from "../lib/threadSort";
import {
  selectProjectByRef,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  selectThreadByRef,
  useStore,
} from "../store";
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
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useRelativeTimeTick } from "../hooks/useRelativeTimeTick";
import { retainThreadDetailSubscription } from "../environments/runtime/service";
import { useThreadActions } from "../hooks/useThreadActions";
import {
  buildThreadRouteParams,
  resolveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import { Kbd } from "./ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useCommandPaletteStore } from "../commandPaletteStore";
import {
  buildProjectScopeOptions,
  canMarkThreadDone,
  countThreadsNeedingUser,
  getSidebarThreadIdsToPrewarm,
  isNeedsUserStatus,
  INBOX_AUTO_DONE_AFTER_DAYS,
  isThreadDone,
  resolveAdjacentThreadId,
  resolveDoneTimestamp,
  resolveSidebarNewThreadSeedContext,
  resolveSidebarNewThreadEnvMode,
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
  sortDoneThreads,
  sortInboxThreads,
  windowInboxThreads,
  useThreadJumpHintVisibility,
  type ThreadStatusPill,
} from "./Sidebar.logic";
import { InboxDoneRow, InboxThreadRow } from "./sidebar/InboxRows";
import { ProjectScopeMenu } from "./sidebar/ProjectScopeMenu";
import { SidebarHoverCardGroup } from "./sidebar/hoverCard";
import { resolveThreadActionProjectRef, startNewGeneralChatThread } from "../lib/chatThreadActions";
import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";
import { SidebarVersionTag } from "./sidebar/SidebarVersionTag";
import { readEnvironmentApi } from "../environmentApi";
import { useSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "../rpc/serverState";
import { resolveElectronSidebarWordmarkLayout } from "../desktopChrome";
import { derivePhysicalProjectKey, selectProjectGroupingSettings } from "../logicalProject";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import type { SidebarThreadSummary } from "../types";
import {
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { SidebarProviderUpdatePill } from "./sidebar/SidebarProviderUpdatePill";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { CommandDialogTrigger } from "./ui/command";

const EMPTY_THREAD_JUMP_LABELS = new Map<string, string>();
/** How many quiet live rows rest unfolded; rows needing you are never folded. */
const LIVE_PREVIEW_COUNT = 6;
/** The Done tail opens short and reveals in bigger steps: it is history. */
const DONE_PREVIEW_COUNT = 10;
const DONE_REVEAL_STEP = 20;
// The queued-turn grace window is measured in minutes, so a coarse clock is
// enough to keep "can this be marked done" honest without re-rendering often.
const INBOX_CLOCK_INTERVAL_MS = 30_000;

interface InboxEntry {
  thread: SidebarThreadSummary;
  threadKey: string;
  status: ThreadStatusPill | null;
  projectKey: string;
  projectLabel: string | null;
  isDone: boolean;
  canMarkDone: boolean;
  doneAt: string | null;
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

/** Section voice for the inbox: mono, quiet, with the count on the right. */
/**
 * Section voice for the inbox, and the list's only structural rule: with rows
 * separated by spacing rather than borders, the hairline belongs to the
 * boundary between sections.
 */
function InboxSectionHeader({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <>
      <SidebarSeparator className="my-1.5" />
      <div className="flex items-baseline gap-2 px-3 pb-1.5">
        <SectionLabel tick={false} className="font-mono text-[11px] tracking-[0.06em]">
          {label}
        </SectionLabel>
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground/45">
          {children}
        </span>
      </div>
    </>
  );
}

const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const electronWordmarkLayout = resolveElectronSidebarWordmarkLayout(
    typeof navigator === "undefined" ? "" : navigator.platform,
  );
  const wordmark = (
    <div className="flex min-w-0 items-center gap-2">
      <SidebarTrigger
        className="size-7 shrink-0 text-muted-foreground/60 hover:text-foreground md:hidden"
        tooltip="Collapse sidebar"
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              aria-label={`Go to ${APP_BASE_NAME} home`}
              className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md text-foreground outline-hidden transition-opacity hover:opacity-85 focus-ring"
              to="/"
            >
              <ThreadlinesGlyph aria-hidden="true" className="h-3 w-auto shrink-0" />
              <span className="truncate text-sm font-semibold tracking-tight">{APP_BASE_NAME}</span>
            </Link>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          <div className="flex flex-col gap-0.5">
            <span>Home</span>
            <span className="text-[10px] text-muted-foreground">
              {APP_STAGE_LABEL} · Version {APP_VERSION}
            </span>
          </div>
        </TooltipPopup>
      </Tooltip>
    </div>
  );

  return isElectron ? (
    <SidebarHeader className="drag-region shrink-0 gap-0 px-0 py-0">
      {electronWordmarkLayout.spacerClassName ? (
        <div aria-hidden="true" className={electronWordmarkLayout.spacerClassName} />
      ) : null}
      <div className={electronWordmarkLayout.wordmarkRowClassName}>{wordmark}</div>
    </SidebarHeader>
  ) : (
    <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-5 sm:py-3 md:shrink-0 md:gap-0 md:px-0 md:py-0">
      <div className="min-w-0 md:flex md:h-[var(--workspace-topbar-height)] md:min-h-[var(--workspace-topbar-height)] md:items-center md:pr-3 md:pl-[var(--workspace-titlebar-content-left)]">
        {wordmark}
      </div>
    </SidebarHeader>
  );
});

const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  // On mobile, /settings renders a full-page section index, so the sheet
  // closes to reveal it; the sheet itself never hosts settings navigation.
  const handleSettingsClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/settings" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarFooter className="p-2">
      <SidebarProviderUpdatePill />
      <SidebarUpdatePill />
      <SidebarMenu>
        <SidebarMenuItem className="flex items-center gap-1.5">
          <SidebarMenuButton
            size="sm"
            className="flex-1 gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
            onClick={handleSettingsClick}
          >
            <SettingsIcon className="size-3.5" />
            <span className="text-xs">Settings</span>
          </SidebarMenuButton>
          <SidebarVersionTag />
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
});

/**
 * The sidebar is an inbox.
 *
 * One live list holding every thread that is still open, ordered by when it
 * was created and never reordered by activity, so a row keeps its place from
 * open until it is marked done. Below it, the Done tail, ordered by when the
 * work ended. Projects are a scope filter across the top rather than a tree:
 * every row names its own project, so nothing has to be traced back to a
 * group header.
 */
export default function Sidebar() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const sidebarThreads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const threadLastVisitedAtById = useUiStateStore((store) => store.threadLastVisitedAtById);
  const doneThreadOverrides = useUiStateStore((store) => store.doneThreadOverrides);
  const inboxProjectScopeKey = useUiStateStore((store) => store.inboxProjectScopeKey);
  const setInboxProjectScope = useUiStateStore((store) => store.setInboxProjectScope);
  const markThreadDoneInStore = useUiStateStore((store) => store.markThreadDone);
  const reopenThreadInStore = useUiStateStore((store) => store.reopenThread);
  const markThreadUnread = useUiStateStore((store) => store.markThreadUnread);
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const isOnSettings = pathname.startsWith("/settings");
  const isOnChats = pathname.startsWith("/chats");
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const appSettingsConfirmThreadArchive = useSettings<boolean>(
    (settings) => settings.confirmThreadArchive,
  );
  const appSettingsConfirmThreadDelete = useSettings<boolean>(
    (settings) => settings.confirmThreadDelete,
  );
  const defaultThreadEnvMode = useSettings<ThreadEnvMode>(
    (settings) => settings.defaultThreadEnvMode,
  );
  // The full hook (rather than `useNewThreadHandler`) because compose has to
  // resolve the same default project and draft context the app menu's "New
  // thread" action uses.
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const { archiveThread, deleteThread, pinThread, unpinThread } = useThreadActions();
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
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [confirmingArchiveThreadKey, setConfirmingArchiveThreadKey] = useState<string | null>(null);
  const [liveListExpanded, setLiveListExpanded] = useState(false);
  const [revealedDoneCount, setRevealedDoneCount] = useState(0);
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const confirmArchiveButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const nowMs = useRelativeTimeTick(INBOX_CLOCK_INTERVAL_MS);
  const nowIso = useMemo(() => new Date(nowMs).toISOString(), [nowMs]);

  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: (ctx) => {
      toastManager.add({ type: "success", title: "Path copied", description: ctx.path });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });

  const physicalToLogicalKey = useMemo(
    () =>
      buildPhysicalToLogicalProjectKeyMap({
        projects,
        settings: projectGroupingSettings,
      }),
    [projects, projectGroupingSettings],
  );
  const projectPhysicalKeyByScopedRef = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          derivePhysicalProjectKey(project),
        ]),
      ),
    [projects],
  );
  const sidebarProjects = useMemo<SidebarProjectSnapshot[]>(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => {
          const rt = savedEnvironmentRuntimeById[environmentId];
          const saved = savedEnvironmentRegistry[environmentId];
          return rt?.descriptor?.label ?? saved?.label ?? null;
        },
      }),
    [
      projects,
      projectGroupingSettings,
      primaryEnvironmentId,
      savedEnvironmentRegistry,
      savedEnvironmentRuntimeById,
    ],
  );
  const sidebarProjectByKey = useMemo(
    () => new Map(sidebarProjects.map((project) => [project.projectKey, project] as const)),
    [sidebarProjects],
  );
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

  const resolveProjectKeyForRef = useCallback(
    (projectRef: ScopedProjectRef) => {
      const scopedRef = scopedProjectKey(projectRef);
      const physicalKey = projectPhysicalKeyByScopedRef.get(scopedRef) ?? scopedRef;
      return physicalToLogicalKey.get(physicalKey) ?? physicalKey;
    },
    [physicalToLogicalKey, projectPhysicalKeyByScopedRef],
  );
  const resolveThreadProjectKey = useCallback(
    (thread: SidebarThreadSummary) =>
      resolveProjectKeyForRef(scopeProjectRef(thread.environmentId, thread.projectId)),
    [resolveProjectKeyForRef],
  );

  // General chats belong to no project and have their own page; they never
  // join the inbox, which is the list of project work.
  const generalChatProjectKeys = useMemo(
    () =>
      new Set(
        sidebarProjects
          .filter((project) => project.kind === "general-chat")
          .map((project) => project.projectKey),
      ),
    [sidebarProjects],
  );
  const inboxThreads = useMemo(
    () =>
      sidebarThreads.filter(
        (thread) =>
          thread.archivedAt === null &&
          !generalChatProjectKeys.has(resolveThreadProjectKey(thread)),
      ),
    [generalChatProjectKeys, resolveThreadProjectKey, sidebarThreads],
  );
  const hasWorkspaceProjects = sidebarProjects.some((project) => project.kind !== "general-chat");

  const entries = useMemo<InboxEntry[]>(
    () =>
      inboxThreads.map((thread) => {
        const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        const lastVisitedAt = threadLastVisitedAtById[threadKey];
        const status = resolveThreadStatusPill({
          thread: {
            ...thread,
            ...(lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
          },
        });
        const projectKey = resolveThreadProjectKey(thread);
        const override = doneThreadOverrides[threadKey];
        const isDone = isThreadDone({ ...thread, lastVisitedAt }, override, {
          now: nowIso,
          autoDoneAfterDays: INBOX_AUTO_DONE_AFTER_DAYS,
        });
        return {
          thread,
          threadKey,
          status,
          projectKey,
          projectLabel: sidebarProjectByKey.get(projectKey)?.displayName ?? null,
          isDone,
          canMarkDone: canMarkThreadDone(thread, { now: nowIso }),
          doneAt: isDone ? resolveDoneTimestamp(thread, override) : null,
        };
      }),
    [
      doneThreadOverrides,
      inboxThreads,
      nowIso,
      resolveThreadProjectKey,
      sidebarProjectByKey,
      threadLastVisitedAtById,
    ],
  );

  const scopedProjectKeyValue =
    inboxProjectScopeKey !== null && sidebarProjectByKey.has(inboxProjectScopeKey)
      ? inboxProjectScopeKey
      : null;

  const scopeOptions = useMemo(() => {
    const lastActivityMsByKey = new Map<string, number>();
    const needsYouCountByKey = new Map<string, number>();
    for (const entry of entries) {
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
    return buildProjectScopeOptions({
      projects: sidebarProjects
        .filter((project) => project.kind !== "general-chat")
        .map((project) => ({ key: project.projectKey, label: project.displayName })),
      lastActivityMsByKey,
      needsYouCountByKey,
    });
  }, [entries, sidebarProjects]);

  const { liveEntries, doneEntries } = useMemo(() => {
    const scoped =
      scopedProjectKeyValue === null
        ? entries
        : entries.filter((entry) => entry.projectKey === scopedProjectKeyValue);
    const entryByThreadKey = new Map(scoped.map((entry) => [entry.threadKey, entry] as const));
    const lookup = (thread: SidebarThreadSummary) =>
      entryByThreadKey.get(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))!;
    const liveEntries = sortInboxThreads(
      scoped.filter((entry) => !entry.isDone).map((entry) => entry.thread),
    ).map(lookup);
    const doneEntries = sortDoneThreads(
      scoped.filter((entry) => entry.isDone).map((entry) => entry.thread),
      (thread) =>
        doneThreadOverrides[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
    ).map(lookup);
    return { liveEntries, doneEntries };
  }, [doneThreadOverrides, entries, scopedProjectKeyValue]);

  const needsYouCount = useMemo(
    () => countThreadsNeedingUser(liveEntries.map((entry) => entry.status)),
    [liveEntries],
  );
  // Volume is managed by folding, not by flattening rows: quiet threads past
  // the limit fold away, and anything with a status stays put.
  const { visible: visibleLiveEntries, hiddenCount: hiddenLiveCount } = useMemo(
    () =>
      windowInboxThreads({
        rows: liveEntries,
        hasAttention: (entry) => entry.status !== null,
        limit: LIVE_PREVIEW_COUNT,
        expanded: liveListExpanded,
      }),
    [liveEntries, liveListExpanded],
  );
  const visibleDoneEntries = useMemo(
    () => doneEntries.slice(0, DONE_PREVIEW_COUNT + revealedDoneCount),
    [doneEntries, revealedDoneCount],
  );
  const nextDoneRevealCount = Math.min(
    DONE_REVEAL_STEP,
    doneEntries.length - visibleDoneEntries.length,
  );

  // A new scope is a new list; the reveals from the old one mean nothing here.
  useEffect(() => {
    setLiveListExpanded(false);
    setRevealedDoneCount(0);
  }, [scopedProjectKeyValue]);

  const orderedThreadKeys = useMemo(
    () => [
      ...visibleLiveEntries.map((entry) => entry.threadKey),
      ...visibleDoneEntries.map((entry) => entry.threadKey),
    ],
    [visibleDoneEntries, visibleLiveEntries],
  );

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

  const openPrLink = useCallback((event: React.MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readLocalApi();
    if (!api) {
      toastManager.add({ type: "error", title: "Link opening is unavailable." });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open pull request link",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, []);

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

  const attemptTogglePinThread = useCallback(
    async (threadRef: ScopedThreadRef, shouldPin: boolean) => {
      try {
        if (shouldPin) {
          await pinThread(threadRef);
        } else {
          await unpinThread(threadRef);
        }
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: shouldPin ? "Failed to pin thread" : "Failed to unpin thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [pinThread, unpinThread],
  );

  const markThreadDone = useCallback(
    (threadKey: string) => {
      markThreadDoneInStore(threadKey, new Date().toISOString());
    },
    [markThreadDoneInStore],
  );
  const reopenThread = useCallback(
    (threadKey: string) => {
      reopenThreadInStore(threadKey, new Date().toISOString());
    },
    [reopenThreadInStore],
  );

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

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;

      const clicked = await api.contextMenu.show(
        [
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const threadKey of threadKeys) {
          const thread = sidebarThreadByKeyRef.current.get(threadKey);
          markThreadUnread(threadKey, thread?.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }

      if (clicked !== "delete") return;

      if (appSettingsConfirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} thread${count === 1 ? "" : "s"}?`,
            "This permanently clears conversation history for these threads.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }

      const deletedThreadKeys = new Set(threadKeys);
      for (const threadKey of threadKeys) {
        const thread = sidebarThreadByKeyRef.current.get(threadKey);
        if (!thread) continue;
        await deleteThread(scopeThreadRef(thread.environmentId, thread.id), { deletedThreadKeys });
      }
      removeFromSelection(threadKeys);
    },
    [
      appSettingsConfirmThreadDelete,
      clearSelection,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
    ],
  );

  const handleThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKey = scopedThreadKey(threadRef);
      const thread = sidebarThreadByKeyRef.current.get(threadKey) ?? null;
      if (!thread) return;
      const threadProject = selectProjectByRef(
        useStore.getState(),
        scopeProjectRef(thread.environmentId, thread.projectId),
      );
      const threadWorkspacePath = thread.worktreePath ?? threadProject?.cwd ?? null;
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread" },
          {
            id: thread.pinnedAt === null ? "pin" : "unpin",
            label: thread.pinnedAt === null ? "Pin" : "Unpin",
          },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "rename") {
        setRenamingThreadKey(threadKey);
        setRenamingTitle(thread.title);
        renamingCommittedRef.current = false;
        return;
      }

      if (clicked === "pin" || clicked === "unpin") {
        await attemptTogglePinThread(threadRef, clicked === "pin");
        return;
      }

      if (clicked === "mark-unread") {
        markThreadUnread(threadKey, thread.latestTurn?.completedAt);
        return;
      }
      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Path unavailable",
              description: "This thread does not have a workspace path to copy.",
            }),
          );
          return;
        }
        copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(thread.id, { threadId: thread.id });
        return;
      }
      if (clicked !== "delete") return;
      if (appSettingsConfirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }
      await deleteThread(threadRef);
    },
    [
      appSettingsConfirmThreadDelete,
      attemptTogglePinThread,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      markThreadUnread,
    ],
  );

  const createThreadForProjectRef = useCallback(
    (projectRef: ScopedProjectRef) => {
      const currentRouteParams =
        router.state.matches[router.state.matches.length - 1]?.params ?? {};
      const currentRouteTarget = resolveThreadRouteTarget(currentRouteParams);
      const currentActiveThread =
        currentRouteTarget?.kind === "server"
          ? (selectThreadByRef(useStore.getState(), currentRouteTarget.threadRef) ?? null)
          : null;
      const draftStore = useComposerDraftStore.getState();
      const currentActiveDraftThread =
        currentRouteTarget?.kind === "server"
          ? (draftStore.getDraftThread(currentRouteTarget.threadRef) ?? null)
          : currentRouteTarget?.kind === "draft"
            ? (draftStore.getDraftSession(currentRouteTarget.draftId) ?? null)
            : null;
      const seedContext = resolveSidebarNewThreadSeedContext({
        projectId: projectRef.projectId,
        defaultEnvMode: resolveSidebarNewThreadEnvMode({ defaultEnvMode: defaultThreadEnvMode }),
        activeThread:
          currentActiveThread && currentActiveThread.projectId === projectRef.projectId
            ? {
                projectId: currentActiveThread.projectId,
                branch: currentActiveThread.branch,
                worktreePath: currentActiveThread.worktreePath,
              }
            : null,
        activeDraftThread:
          currentActiveDraftThread && currentActiveDraftThread.projectId === projectRef.projectId
            ? {
                projectId: currentActiveDraftThread.projectId,
                branch: currentActiveDraftThread.branch,
                worktreePath: currentActiveDraftThread.worktreePath,
                envMode: currentActiveDraftThread.envMode,
              }
            : null,
      });
      void handleNewThread(projectRef, {
        ...(seedContext.branch !== undefined ? { branch: seedContext.branch } : {}),
        ...(seedContext.worktreePath !== undefined
          ? { worktreePath: seedContext.worktreePath }
          : {}),
        envMode: seedContext.envMode,
      });
    },
    [defaultThreadEnvMode, handleNewThread, router],
  );

  // Compose follows the thread you are in. While the list is scoped to a
  // single project, that project wins instead: filtering to it and then
  // getting a thread somewhere else reads as the button ignoring you.
  const handleComposeClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    const scopedProject =
      scopedProjectKeyValue === null
        ? null
        : (sidebarProjectByKey.get(scopedProjectKeyValue) ?? null);
    const scopedMember =
      scopedProject && scopedProject.memberProjects.length === 1
        ? scopedProject.memberProjects[0]!
        : null;
    const projectRef = scopedMember
      ? scopeProjectRef(scopedMember.environmentId, scopedMember.id)
      : resolveThreadActionProjectRef({
          activeDraftThread,
          activeThread,
          defaultProjectRef,
          defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: defaultThreadEnvMode,
          }),
          handleNewThread,
        });
    if (!projectRef) {
      return;
    }
    // General chats run in per-thread scratch directories; branch and worktree
    // seeding does not apply to them.
    if (generalChatProjectKeys.has(resolveProjectKeyForRef(projectRef))) {
      void startNewGeneralChatThread(handleNewThread, projectRef);
      return;
    }
    createThreadForProjectRef(projectRef);
  }, [
    activeDraftThread,
    activeThread,
    createThreadForProjectRef,
    defaultProjectRef,
    defaultThreadEnvMode,
    generalChatProjectKeys,
    handleNewThread,
    isMobile,
    resolveProjectKeyForRef,
    scopedProjectKeyValue,
    setOpenMobile,
    sidebarProjectByKey,
  ]);

  const handleOpenChats = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/chats" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleScopeChange = useCallback(
    (projectKey: string | null) => {
      setInboxProjectScope(projectKey);
    },
    [setInboxProjectScope],
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

  const prewarmedSidebarThreadRefs = useMemo(
    () =>
      getSidebarThreadIdsToPrewarm(orderedThreadKeys).flatMap((threadKey) => {
        const ref = parseScopedThreadKey(threadKey);
        return ref ? [ref] : [];
      }),
    [orderedThreadKeys],
  );

  useEffect(() => {
    const releases = prewarmedSidebarThreadRefs.map((ref) =>
      retainThreadDetailSubscription(ref.environmentId, ref.threadId),
    );

    return () => {
      for (const release of releases) {
        release();
      }
    };
  }, [prewarmedSidebarThreadRefs]);

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
          threadIds: orderedThreadKeys,
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
    orderedThreadKeys,
    platform,
    routeThreadKey,
    sidebarThreadByKey,
    threadJumpThreadKeys,
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

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />

      {isOnSettings && !isMobile ? (
        // Desktop only: mobile keeps the thread list in the sheet and gets a
        // full-page section index at /settings instead of a sidebar nav swap.
        <SettingsSidebarNav pathname={pathname} />
      ) : (
        <>
          <SidebarHoverCardGroup>
            <SidebarContent className="gap-0">
              <SidebarGroup className="px-2 pt-2 pb-1">
                <div className="flex items-center gap-1.5">
                  <CommandDialogTrigger
                    render={
                      <button
                        type="button"
                        data-testid="command-palette-trigger"
                        className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2 text-muted-foreground/70 transition-colors hover:border-border hover:bg-muted/50 hover:text-foreground focus-ring"
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
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label="New thread"
                          data-testid="new-thread-button"
                          className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-ring"
                          onClick={handleComposeClick}
                        />
                      }
                    >
                      <SquarePenIcon className="size-3.5" />
                    </TooltipTrigger>
                    <TooltipPopup side="bottom">
                      {newThreadShortcutLabel
                        ? `New thread (${newThreadShortcutLabel})`
                        : "New thread"}
                    </TooltipPopup>
                  </Tooltip>
                </div>
              </SidebarGroup>

              <div className="px-2 pb-1">
                <button
                  type="button"
                  data-testid="sidebar-general-chats"
                  aria-current={isOnChats ? "page" : undefined}
                  className={cn(
                    "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-xs transition-colors focus-ring",
                    isOnChats
                      ? "bg-sidebar-accent text-foreground"
                      : "text-muted-foreground/80 hover:bg-sidebar-accent/60 hover:text-foreground",
                  )}
                  onClick={handleOpenChats}
                >
                  <MessagesSquareIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">General Chats</span>
                </button>
              </div>

              <ProjectScopeMenu
                options={scopeOptions}
                projectByKey={sidebarProjectByKey}
                scopedProjectKey={scopedProjectKeyValue}
                onScopeChange={handleScopeChange}
                onAddProject={openAddProjectCommandPalette}
              />

              <InboxSectionHeader label="Threads">
                {liveEntries.length > 0 ? (
                  <>
                    {needsYouCount > 0 ? (
                      <span className="text-amber-600 dark:text-amber-300/90">
                        {needsYouCount} need{needsYouCount === 1 ? "s" : ""} you
                      </span>
                    ) : null}
                    {needsYouCount > 0 ? " · " : null}
                    {liveEntries.length}
                  </>
                ) : null}
              </InboxSectionHeader>

              {liveEntries.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-muted-foreground/60">
                  {hasWorkspaceProjects ? "No threads yet" : "No projects yet"}
                </div>
              ) : (
                <ul data-testid="inbox-thread-list">
                  {visibleLiveEntries.map((entry) => (
                    <InboxThreadRow
                      key={entry.threadKey}
                      thread={entry.thread}
                      status={entry.status}
                      projectLabel={scopedProjectKeyValue === null ? entry.projectLabel : null}
                      isActive={routeThreadKey === entry.threadKey}
                      jumpLabel={visibleThreadJumpLabelByKey.get(entry.threadKey) ?? null}
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
                      attemptTogglePinThread={attemptTogglePinThread}
                      markThreadDone={markThreadDone}
                      openPrLink={openPrLink}
                    />
                  ))}
                </ul>
              )}

              {hiddenLiveCount > 0 || liveListExpanded ? (
                <>
                  <SidebarSeparator className="my-1.5" />
                  <button
                    type="button"
                    data-thread-selection-safe
                    data-testid="inbox-live-show-more"
                    className={cn(
                      "w-full cursor-pointer px-3 pb-1.5 text-left text-[11px]",
                      "text-muted-foreground/45 transition-colors hover:text-muted-foreground focus-ring",
                    )}
                    onClick={() => {
                      setLiveListExpanded((expanded) => !expanded);
                    }}
                  >
                    {liveListExpanded ? "Show fewer" : `Show ${hiddenLiveCount} more…`}
                  </button>
                </>
              ) : null}

              {doneEntries.length > 0 ? (
                <>
                  <InboxSectionHeader label="Done">{doneEntries.length}</InboxSectionHeader>
                  <ul data-testid="inbox-done-list">
                    {visibleDoneEntries.map((entry) => (
                      <InboxDoneRow
                        key={entry.threadKey}
                        thread={entry.thread}
                        projectLabel={scopedProjectKeyValue === null ? entry.projectLabel : null}
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
                      />
                    ))}
                  </ul>
                  {nextDoneRevealCount > 0 ? (
                    <button
                      type="button"
                      data-thread-selection-safe
                      data-testid="inbox-done-show-more"
                      className={cn(
                        "w-full cursor-pointer px-3 pt-2 pb-3 text-left text-[11px]",
                        "text-muted-foreground/45 transition-colors hover:text-muted-foreground focus-ring",
                      )}
                      onClick={() => {
                        setRevealedDoneCount((current) => current + DONE_REVEAL_STEP);
                      }}
                    >
                      Show {nextDoneRevealCount} more…
                    </button>
                  ) : null}
                </>
              ) : null}
            </SidebarContent>
          </SidebarHoverCardGroup>

          <SidebarSeparator />
          <SidebarChromeFooter />
        </>
      )}
    </>
  );
}
