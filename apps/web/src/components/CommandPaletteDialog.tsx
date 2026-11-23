"use client";

import { usePullRequestRecords } from "../environments/pullRequests/pullRequestRecordsStore";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@threadlines/client-runtime";
import { resolveThreadWorkingCwd } from "@threadlines/shared/threadCwd";
import {
  DEFAULT_NEW_THREAD_RUNTIME_MODE,
  type EnvironmentId,
  type KeybindingCommand,
  type ProjectId,
} from "@threadlines/contracts";

import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  BotIcon,
  ChartColumnIcon,
  CloudIcon,
  CircleArrowUpIcon,
  MessageCircleWarningIcon,
  EraserIcon,
  FileTextIcon,
  FolderGitIcon,
  FolderPlusIcon,
  GitPullRequestIcon,
  HomeIcon,
  LaptopIcon,
  MessageSquareIcon,
  MessageCirclePlusIcon,
  MessagesSquareIcon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  SquareSplitHorizontalIcon,
  TerminalSquareIcon,
  Trash2Icon,
  UsersRoundIcon,
  MonitorUpIcon,
  CrownIcon,
  ScrollTextIcon,
  FolderSyncIcon,
  WaypointsIcon,
  CalendarClockIcon,
  CalendarPlusIcon,
  ArchiveIcon,
  CheckIcon,
  CopyIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlugIcon,
  CameraIcon,
  SmartphoneIcon,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { openAddProject } from "./addProject/addProjectStore";
import {
  useAddProjectEnvironmentOptions,
  useEnvironmentBrowsePlatform,
} from "./addProject/addProjectComputers";
import { openCodexImport } from "./codexImport/codexImportStore";
import { useRoomRecipientStore } from "../rooms";
import { useChatFindStore } from "../chatFindStore";
import { useComposerCommandsStore } from "../composerCommands";
import { type TerminalCommandKind, useTerminalCommandsStore } from "../terminalCommands";
import { derivePendingApprovals } from "../session-logic";

import { usePrimaryEnvironmentId } from "../environments/primary";
import { openComputerRenameDialog, useComputerNaming } from "./DeviceRenameDialog";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { holdThreadDetailForOpen, prewarmHighlightedThread } from "../environments/runtime/service";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useGeneralChats } from "./chats/useGeneralChats";
import { requestGeneralChatsReveal } from "./chats/generalChatsPlacement";
import { useInboxThreads } from "../hooks/useInboxThreads";
import { useThreadMenu } from "../hooks/useThreadMenu";
import {
  createLeadChat,
  environmentSupportsProjectLead,
  leadSettingRefusal,
  projectLeadRef,
} from "../leadChat";
import { useWorktreePickup } from "../hooks/useWorktreePickup";
import type { ThreadMenuAction } from "./threadMenu.logic";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useSettings } from "../hooks/useSettings";
import { selectSidebarListShown, useUiStateStore } from "../uiStateStore";
import { useWorktreePickupStore } from "../worktreePickup";
import { useRoomsEnabled } from "../hooks/useRoomsEnabled";

import { closeRightPanelSearchParams } from "../diffRouteSearch";

import {
  startNewThreadInProjectFromContext,
  startNewThreadFromContext,
} from "../lib/chatThreadActions";
import { isFilesystemBrowseQuery } from "../lib/projectPaths";

import { getLatestThreadForProject } from "../lib/threadSort";
import { threadSearchQueryOptions, type ThreadSearchTarget } from "../lib/threadSearchReactQuery";
import {
  PULL_REQUEST_COUNT_REFETCH_INTERVAL_MS,
  usePullRequestEnvironments,
  usePullRequestLists,
} from "../lib/pullRequestsReactQuery";
import { useGitStatus } from "../lib/gitStatusState";
import { useScheduledTaskEnvironments } from "../lib/scheduledTasksState";
import { resolveThreadPullRequest, threadViewBranch } from "./pull-requests/pullRequests.logic";
import {
  focusRightPanelTab,
  pullRequestTabSearchParams,
  rightPanelTabSearchParams,
} from "../rightPanelTabs";
import { cn, newCommandId } from "../lib/utils";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  ADDON_ICON_CLASS,
  applyThreadContentSearchMatches,
  buildProjectActionItems,
  buildRootGroups,
  buildThreadActionItems,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  filterCommandPaletteGroups,
  getCommandPaletteInputPlaceholder,
  highlightedThreadKeyOf,
  ITEM_ICON_CLASS,
  normalizeSearchText,
  RECENT_THREAD_LIMIT,
} from "./CommandPalette.logic";

import { CommandPaletteResults } from "./CommandPaletteResults";

import { openConnectComputerDialog } from "./settings/connections/JoinComputerDialog";
import { openThreadMoveDialog } from "./ThreadMoveDialog";
import { openProjectSetupDialog } from "./ProjectSetupDialog";
import {
  PROJECT_BRIEF_MENU_LABEL,
  projectBriefLocation,
  useProjectBriefSupport,
} from "../projectBrief";
import { openReportProblemDialog } from "./ReportProblemDialog";
import { openWhatsNewDialog } from "./WhatsNewDialog";
import { APP_VERSION } from "../branding";
import { useProjectSetupTargets } from "../environments/projectSetups/projectSetupTargets";
import { useMoveThreadsOffered, useThreadMoveOffered } from "../environments/links/threadMoves";
import { openMoveThreadsDialog } from "./MoveThreadsDialog";
import { environmentSupportsDevices } from "./device/deviceState";
import {
  startAssistantCode,
  useOutsideAgentsSnapshot,
} from "../environments/outsideAgents/outsideAgents";
import { threadMoveStatus } from "../threadMove";

import { ProjectFavicon } from "./ProjectFavicon";
import { ThreadRowLeadingStatus, ThreadRowTrailingStatus } from "./ThreadStatusIndicators";
import { useServerKeybindings, useServerProviders } from "../rpc/serverState";

import { deriveProviderInstanceEntries } from "../providerInstances";
import {
  Command,
  CommandDialogPopup,
  CommandFooter,
  CommandInput,
  CommandPanel,
} from "./ui/command";

import { Kbd, KbdGroup } from "./ui/kbd";
import { failureNotice, toastManager } from "./ui/toast";

import { useComposerHandleContext } from "../composerHandleContext";

const THREAD_CONTENT_SEARCH_DEBOUNCE_MS = 180;
const EMPTY_THREAD_CONTENT_MATCHES = [] as const;

const THEME_ITEM_CLASSES = { item: ITEM_ICON_CLASS, addon: ADDON_ICON_CLASS } as const;
/**
 * The open palette: search, actions and the add-project flows. Loaded on
 * demand by CommandPalette, which owns the open state and the shortcut.
 */
/**
 * The thread menu's actions the palette offers for the open thread, by what
 * they are called here. Mark unread, the family's and Move (its own entry)
 * stay in the menu.
 */
const PALETTE_THREAD_ACTIONS: Partial<
  Record<
    ThreadMenuAction,
    {
      /** Absent: the menu item's own words, for an action whose words change. */
      readonly title?: string;
      readonly searchTerms: string[];
      readonly icon: ReactNode;
    }
  >
> = {
  "make-lead": {
    searchTerms: ["lead chat", "lead", "coordinate", "project lead"],
    icon: <CrownIcon className={ITEM_ICON_CLASS} />,
  },
  "stop-lead": {
    searchTerms: ["lead chat", "lead", "coordinate", "project lead"],
    icon: <CrownIcon className={ITEM_ICON_CLASS} />,
  },
  rename: {
    title: "Rename thread",
    searchTerms: ["rename", "title", "name"],
    icon: <PencilIcon className={ITEM_ICON_CLASS} />,
  },
  pin: {
    title: "Pin thread",
    searchTerms: ["pin", "keep", "top"],
    icon: <PinIcon className={ITEM_ICON_CLASS} />,
  },
  unpin: {
    title: "Unpin thread",
    searchTerms: ["unpin"],
    icon: <PinOffIcon className={ITEM_ICON_CLASS} />,
  },
  "wrap-up": {
    title: "Wrap up thread",
    searchTerms: ["wrap up", "done", "finish", "file away"],
    icon: <CheckIcon className={ITEM_ICON_CLASS} />,
  },
  reopen: {
    title: "Reopen thread",
    searchTerms: ["reopen", "active", "unwrap"],
    icon: <RotateCcwIcon className={ITEM_ICON_CLASS} />,
  },
  "copy-path": {
    title: "Copy thread path",
    searchTerms: ["copy", "path", "folder", "directory"],
    icon: <CopyIcon className={ITEM_ICON_CLASS} />,
  },
  "copy-thread-id": {
    title: "Copy thread ID",
    searchTerms: ["copy", "id"],
    icon: <CopyIcon className={ITEM_ICON_CLASS} />,
  },
  archive: {
    title: "Archive thread",
    searchTerms: ["archive", "hide", "put away"],
    icon: <ArchiveIcon className={ITEM_ICON_CLASS} />,
  },
  delete: {
    title: "Delete thread",
    searchTerms: ["delete", "remove", "trash"],
    icon: <Trash2Icon className={ITEM_ICON_CLASS} />,
  },
};

export function OpenCommandPaletteDialog() {
  const navigate = useNavigate();
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const chatFindAvailable = useChatFindStore((store) => store.available);
  const openIntent = useCommandPaletteStore((store) => store.openIntent);
  const clearOpenIntent = useCommandPaletteStore((store) => store.clearOpenIntent);
  const composerHandleRef = useComposerHandleContext();
  // Set when a command hands over to another dialog (Add project, Codex
  // import), which then owns where focus returns.
  const handingOverToDialogRef = useRef(false);
  const focusComposer = useCallback(() => {
    composerHandleRef?.current?.focusAtEnd();
  }, [composerHandleRef]);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const isActionsOnly = deferredQuery.startsWith(">");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const settings = useSettings();
  const { activeDraftThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  // The whole open thread: the palette reads its activities, move and mode,
  // which the shared helper leaves out. It is mounted only while open.
  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const { startChat: startGeneralChat } = useGeneralChats();
  const keybindings = useServerKeybindings();
  const isHomeRoute = useLocation({ select: (location) => location.pathname === "/" });
  const onTerminalsPage = useLocation({
    select: (location) => location.pathname === "/terminals",
  });
  const isMobile = useIsMobile();
  const sidebarListOpen = useUiStateStore(selectSidebarListShown);
  const [viewStack, setViewStack] = useState<CommandPaletteView[]>([]);
  const currentView = viewStack.at(-1) ?? null;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryServerProviders = useServerProviders();
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const pullRequestEnvironments = usePullRequestEnvironments();
  const scheduledTaskEnvironments = useScheduledTaskEnvironments();
  // Heard from only for this computer's owner, where its server takes outside agents.
  const managesOutsideAgents = useOutsideAgentsSnapshot() !== null;
  const thisComputerNaming = useComputerNaming(primaryEnvironmentId);
  // The active thread's pull request, so the palette can offer its tab. Both
  // reads are the sidebar's: the same refcounted git status and the same open
  // listing key, and neither runs on a thread with no branch to match.
  const activeThreadProject = activeThread
    ? (projects.find(
        (project) =>
          project.environmentId === activeThread.environmentId &&
          project.id === activeThread.projectId,
      ) ?? null)
    : null;
  const activeThreadRoomsEnabled = useRoomsEnabled(
    activeThread?.environmentId ?? activeDraftThread?.environmentId,
  );
  // The open thread's project, where another computer could take a copy of it.
  const openThreadProjectRef = activeThread
    ? scopeProjectRef(activeThread.environmentId, activeThread.projectId)
    : activeDraftThread
      ? scopeProjectRef(activeDraftThread.environmentId, activeDraftThread.projectId)
      : null;
  const projectSetupTargets = useProjectSetupTargets(openThreadProjectRef);
  // Clearing this computer (Part 3c): several of its threads to a linked one.
  const moveThreadsOffered = useMoveThreadsOffered(primaryEnvironmentId, null);
  const activeThreadMoveOffered = useThreadMoveOffered(
    activeThread
      ? {
          environmentId: activeThread.environmentId,
          projectId: activeThread.projectId,
          moveStatus: threadMoveStatus(activeThread),
        }
      : null,
  );
  // The open thread's own actions are its menu's (useThreadMenu); the inbox
  // says whether it offers Wrap up or Reopen. This mounts only while open.
  const threadMenu = useThreadMenu();
  const { entries: inboxEntries } = useInboxThreads();
  const activeThreadHasBranch = (activeThread?.branch ?? null) !== null;
  const activeThreadGitStatus = useGitStatus({
    environmentId: activeThreadHasBranch ? (activeThread?.environmentId ?? null) : null,
    cwd:
      activeThreadHasBranch && activeThread && activeThreadProject
        ? resolveThreadWorkingCwd({
            projectCwd: activeThreadProject.cwd,
            worktreePath: activeThread.worktreePath,
            effectiveCwd: activeThread.effectiveCwd,
          })
        : null,
  });
  const activeThreadOpenPullRequests = usePullRequestLists({
    state: "open",
    refetchIntervalMs: PULL_REQUEST_COUNT_REFETCH_INTERVAL_MS,
    enabled: activeThreadHasBranch,
  });
  const activeThreadPullRequestRecords = usePullRequestRecords(activeThread?.environmentId);
  const activeThreadPullRequest = activeThread
    ? resolveThreadPullRequest({
        thread: {
          ...activeThread,
          branch: threadViewBranch(activeThread, activeThreadGitStatus.data),
        },
        gitStatus: activeThreadGitStatus.data,
        openEntries: activeThreadOpenPullRequests.entries,
        projects,
        records: activeThreadPullRequestRecords,
      })
    : null;

  const addProjectEnvironmentOptions = useAddProjectEnvironmentOptions();
  // A typed path offers "Add project at <path>" for the computer Add project
  // starts on, read with that computer's idea of a path.
  const defaultAddProjectEnvironmentId = addProjectEnvironmentOptions[0]?.environmentId ?? null;
  const addProjectPathPlatform = useEnvironmentBrowsePlatform(defaultAddProjectEnvironmentId);

  const projectTitleById = useMemo(
    () => new Map<ProjectId, string>(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const projectByScopedKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          project,
        ]),
      ),
    [projects],
  );

  const activeThreadId = activeThread?.id;
  const currentProjectEnvironmentId =
    activeThread?.environmentId ?? activeDraftThread?.environmentId ?? null;
  const currentProjectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? null;
  const currentProject =
    currentProjectId && currentProjectEnvironmentId
      ? (projects.find(
          (project) =>
            project.id === currentProjectId &&
            project.environmentId === currentProjectEnvironmentId,
        ) ?? null)
      : null;
  const currentProjectCwd = currentProject?.cwd ?? null;
  const supportsProjectBrief = useProjectBriefSupport();
  // The project's worktrees made outside Threadlines, asked for while the
  // palette is open: the action below shows only when there is one to add.
  const currentProjectRef = useMemo(
    () =>
      currentProject?.kind === "workspace"
        ? scopeProjectRef(currentProject.environmentId, currentProject.id)
        : null,
    [currentProject?.environmentId, currentProject?.id, currentProject?.kind],
  );
  const worktreePickup = useWorktreePickup({
    projectRef: currentProjectRef,
    projectCwd: currentProjectRef === null ? null : currentProjectCwd,
  });
  const currentEnvironmentProviders = useMemo(
    () =>
      currentProjectEnvironmentId && currentProjectEnvironmentId === primaryEnvironmentId
        ? primaryServerProviders
        : currentProjectEnvironmentId
          ? (savedEnvironmentRuntimeById[currentProjectEnvironmentId]?.serverConfig?.providers ??
            [])
          : [],
    [
      currentProjectEnvironmentId,
      primaryEnvironmentId,
      primaryServerProviders,
      savedEnvironmentRuntimeById,
    ],
  );
  const availableCodexInstances = useMemo(
    () =>
      deriveProviderInstanceEntries(currentEnvironmentProviders).filter(
        (entry) =>
          entry.driverKind === "codex" &&
          entry.enabled &&
          entry.installed &&
          entry.isAvailable &&
          entry.models.length > 0,
      ),
    [currentEnvironmentProviders],
  );
  const openProjectFromSearch = useMemo(
    () => async (project: (typeof projects)[number]) => {
      const latestThread = getLatestThreadForProject(
        threads.filter((thread) => thread.environmentId === project.environmentId),
        project.id,
      );
      if (latestThread) {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(latestThread.environmentId, latestThread.id),
          ),
        });
        return;
      }

      await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    },
    [handleNewThread, navigate, threads],
  );

  const projectSearchItems = useMemo(
    () =>
      buildProjectActionItems({
        projects,
        valuePrefix: "project",
        icon: (project) => (
          <ProjectFavicon
            environmentId={project.environmentId}
            cwd={project.cwd}
            name={project.name}
            className={ITEM_ICON_CLASS}
          />
        ),
        runProject: openProjectFromSearch,
      }),
    [openProjectFromSearch, projects],
  );

  const projectThreadItems = useMemo(
    () =>
      buildProjectActionItems({
        projects,
        valuePrefix: "new-thread-in",
        icon: (project) => (
          <ProjectFavicon
            environmentId={project.environmentId}
            cwd={project.cwd}
            name={project.name}
            className={ITEM_ICON_CLASS}
          />
        ),
        runProject: async (project) => {
          await startNewThreadInProjectFromContext(
            {
              activeDraftThread,
              activeThread,
              defaultProjectRef,
              handleNewThread,
            },
            scopeProjectRef(project.environmentId, project.id),
          );
        },
      }),
    [activeDraftThread, activeThread, defaultProjectRef, handleNewThread, projects],
  );

  const allThreadItems = useMemo(
    () =>
      buildThreadActionItems({
        threads,
        ...(activeThreadId ? { activeThreadId } : {}),
        projectTitleById,
        icon: (thread) => {
          const project = projectByScopedKey.get(
            scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
          );
          if (!project) {
            return <MessageSquareIcon className={ITEM_ICON_CLASS} />;
          }
          if (project.kind === "general-chat") {
            return <MessagesSquareIcon className={ITEM_ICON_CLASS} />;
          }
          return (
            <ProjectFavicon
              environmentId={project.environmentId}
              cwd={project.cwd}
              name={project.name}
              className={ITEM_ICON_CLASS}
            />
          );
        },
        renderLeadingContent: (thread) => <ThreadRowLeadingStatus thread={thread} />,
        renderTrailingContent: (thread) => <ThreadRowTrailingStatus thread={thread} />,
        runThread: async (thread) => {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
          });
        },
      }),
    [activeThreadId, navigate, projectByScopedKey, projectTitleById, threads],
  );
  const recentThreadItems = allThreadItems.slice(0, RECENT_THREAD_LIMIT);
  const threadContentSearchTargets = useMemo<ReadonlyArray<ThreadSearchTarget>>(() => {
    const scopedProjectIds = currentView?.threadSearchProjectIdsByEnvironment;
    if (currentView && !scopedProjectIds) {
      return [];
    }
    if (scopedProjectIds) {
      return [...scopedProjectIds].map(([environmentId, projectIds]) => ({
        environmentId,
        projectIds,
      }));
    }

    return [...new Set(threads.map((thread) => thread.environmentId))].map((environmentId) => ({
      environmentId,
    }));
  }, [currentView, threads]);
  const [debouncedThreadContentQuery] = useDebouncedValue(
    deferredQuery,
    { wait: THREAD_CONTENT_SEARCH_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const threadContentSearchQuery = useQuery(
    threadSearchQueryOptions({
      query: debouncedThreadContentQuery,
      targets: threadContentSearchTargets,
      enabled: !isActionsOnly,
    }),
  );
  const threadContentMatches =
    normalizeSearchText(debouncedThreadContentQuery) === normalizeSearchText(deferredQuery)
      ? (threadContentSearchQuery.data?.matches ?? EMPTY_THREAD_CONTENT_MATCHES)
      : EMPTY_THREAD_CONTENT_MATCHES;
  const allThreadSearchItems = useMemo(
    () =>
      applyThreadContentSearchMatches({
        items: allThreadItems,
        matches: threadContentMatches,
        query: deferredQuery,
      }),
    [allThreadItems, deferredQuery, threadContentMatches],
  );

  function pushPaletteView(view: CommandPaletteView): void {
    setViewStack((previousViews) => [
      ...previousViews,
      {
        addonIcon: view.addonIcon,
        groups: view.groups,
        ...(view.initialQuery ? { initialQuery: view.initialQuery } : {}),
        ...(view.inputPlaceholder ? { inputPlaceholder: view.inputPlaceholder } : {}),
        ...(view.threadSearchProjectIdsByEnvironment
          ? {
              threadSearchProjectIdsByEnvironment: view.threadSearchProjectIdsByEnvironment,
            }
          : {}),
      },
    ]);
    setHighlightedItemValue(null);
    setQuery(view.initialQuery ?? "");
  }

  function pushView(item: CommandPaletteSubmenuItem): void {
    pushPaletteView({
      addonIcon: item.addonIcon,
      groups: item.groups,
      ...(item.initialQuery ? { initialQuery: item.initialQuery } : {}),
    });
  }

  // Hands over to the Codex import dialog, which takes the project, its
  // accounts and the open thread's mode as they are now.
  function openCodexImportDialog(): void {
    if (!currentProject || currentProject.kind !== "workspace") {
      return;
    }
    openCodexImport({
      project: {
        environmentId: currentProject.environmentId,
        projectId: currentProject.id,
        projectName: currentProject.name,
        cwd: currentProject.cwd,
      },
      accounts: availableCodexInstances.map((instance) => ({
        instanceId: instance.instanceId,
        displayName: instance.displayName,
      })),
      runtimeMode:
        activeThread?.runtimeMode ??
        activeDraftThread?.runtimeMode ??
        DEFAULT_NEW_THREAD_RUNTIME_MODE,
      returnFocus: focusComposer,
    });
  }

  function popView(): void {
    setViewStack((previousViews) => previousViews.slice(0, -1));
    setHighlightedItemValue(null);
    setQuery("");
  }

  function handleQueryChange(nextQuery: string): void {
    setHighlightedItemValue(null);
    setQuery(nextQuery);
    if (nextQuery === "" && currentView?.initialQuery) {
      popView();
    }
  }

  // Sidebar "Search all N threads" hands off here: a submenu view scoped to
  // one logical project's threads, searchable with the usual palette ranking.
  useLayoutEffect(() => {
    if (openIntent?.kind !== "search-threads") {
      return;
    }
    clearOpenIntent();
    const memberProjectKeys = new Set(openIntent.memberProjectKeys);
    const projectThreads = threads.filter((thread) =>
      memberProjectKeys.has(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      ),
    );
    const projectIdsByEnvironment = new Map<EnvironmentId, ProjectId[]>();
    for (const thread of projectThreads) {
      const projectIds = projectIdsByEnvironment.get(thread.environmentId) ?? [];
      if (!projectIds.includes(thread.projectId)) {
        projectIds.push(thread.projectId);
        projectIdsByEnvironment.set(thread.environmentId, projectIds);
      }
    }
    pushPaletteView({
      addonIcon: <MessageSquareIcon className={ADDON_ICON_CLASS} />,
      inputPlaceholder: `Search threads in ${openIntent.projectName}...`,
      threadSearchProjectIdsByEnvironment: projectIdsByEnvironment,
      groups: [
        {
          value: "project-threads",
          label: `Threads in ${openIntent.projectName}`,
          items: buildThreadActionItems({
            threads: projectThreads,
            ...(activeThreadId ? { activeThreadId } : {}),
            projectTitleById,
            icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
            renderLeadingContent: (thread) => <ThreadRowLeadingStatus thread={thread} />,
            renderTrailingContent: (thread) => <ThreadRowTrailingStatus thread={thread} />,
            runThread: async (thread) => {
              await navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
              });
            },
          }),
        },
      ],
    });
  }, [activeThreadId, clearOpenIntent, navigate, openIntent, projectTitleById, threads]);

  const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];

  if (projects.length > 0) {
    const activeProjectTitle = currentProject?.name ?? null;

    if (activeProjectTitle) {
      actionItems.push({
        kind: "action",
        value: "action:new-thread",
        searchTerms: ["new thread", "chat", "create", "draft"],
        title: (
          <>
            New thread in <span className="font-semibold">{activeProjectTitle}</span>
          </>
        ),
        icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "chat.new",
        run: async () => {
          await startNewThreadFromContext({
            activeDraftThread,
            activeThread,
            defaultProjectRef,
            handleNewThread,
          });
        },
      });

      if (
        currentProject?.kind === "workspace" &&
        currentProjectCwd &&
        availableCodexInstances.length > 0
      ) {
        actionItems.push({
          kind: "action",
          value: "action:open-codex-session",
          searchTerms: ["open", "import", "codex", "session", "chat", "conversation"],
          title: "Bring in Codex conversation…",
          description: "Continue work from Codex app, CLI, or IDE",
          icon: <MessagesSquareIcon className={ITEM_ICON_CLASS} />,
          opensDialog: true,
          run: async () => {
            openCodexImportDialog();
          },
        });
      }

      if (currentProjectRef !== null && worktreePickup.candidates.length > 0) {
        const projectRef = currentProjectRef;
        actionItems.push({
          kind: "action",
          value: "action:pick-up-worktrees",
          searchTerms: ["worktree", "existing", "pick up", "import", "branch", "add threads"],
          title: "Add existing worktrees as threads…",
          description: "Worktrees this repository already has, made outside Threadlines",
          icon: <FolderGitIcon className={ITEM_ICON_CLASS} />,
          // Lays the list out on the new-thread screen, where each worktree
          // can be ticked; it also brings a hidden count back.
          run: async () => {
            useWorktreePickupStore.getState().offer(scopedProjectKey(projectRef));
            await handleNewThread(projectRef, { continueActiveCheckout: false });
          },
        });
      }
    }

    if (
      currentProject?.kind === "workspace" &&
      supportsProjectBrief(currentProject.environmentId)
    ) {
      const briefProject = currentProject;
      actionItems.push({
        kind: "action",
        value: "action:project-brief",
        searchTerms: [
          "brief",
          "project brief",
          "notes",
          "instructions",
          "rules",
          briefProject.name,
        ],
        title: PROJECT_BRIEF_MENU_LABEL,
        description: briefProject.name,
        icon: <ScrollTextIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          await navigate(projectBriefLocation(briefProject));
        },
      });
    }

    actionItems.push({
      kind: "submenu",
      value: "action:new-thread-in",
      searchTerms: ["new thread", "project", "pick", "choose", "select"],
      title: "New thread in...",
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
      groups: [{ value: "projects", label: "Projects", items: projectThreadItems }],
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:add-project",
    searchTerms: [
      "add project",
      "folder",
      "directory",
      "browse",
      "clone",
      "remote",
      "repository",
      "repo",
      "git",
      "github",
      "gitlab",
      "bitbucket",
      "azure",
      "devops",
      "url",
      "environment",
    ],
    title: "Add project",
    icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
    opensDialog: true,
    run: async () => {
      openAddProject({ returnFocus: focusComposer });
    },
  });

  if (!isHomeRoute) {
    actionItems.push({
      kind: "action",
      value: "action:go-home",
      searchTerms: ["home", "landing", "start", "threads"],
      title: "Go to Home",
      icon: <HomeIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/" });
      },
    });
  }

  if (startGeneralChat !== null) {
    actionItems.push({
      kind: "action",
      value: "action:new-general-chat",
      searchTerms: ["new chat", "general chat", "chat", "conversation", "no project"],
      title: "New general chat",
      icon: <MessageCirclePlusIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        startGeneralChat();
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:general-chats",
    searchTerms: ["general chats", "chats", "conversations", "no project"],
    title: "Open general chats",
    icon: <MessagesSquareIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      // Where the chats are a section of Threads, the shell opens it there
      // without a stop at the old page's address.
      if (settings.generalChatsPlacement === "threads") requestGeneralChatsReveal();
      else await navigate({ to: "/chats" });
    },
  });

  if (!onTerminalsPage) {
    actionItems.push({
      kind: "action",
      value: "action:terminals",
      searchTerms: ["terminals", "terminal", "shell", "shells", "split terminal", "dev server"],
      title: "Open Terminals",
      description: "Terminal tabs for any project, outside a chat",
      icon: <TerminalSquareIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "navigate.terminals",
      run: async () => {
        await navigate({ to: "/terminals" });
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:fleet",
    searchTerms: ["fleet", "computers", "machines", "devices", "phone", "graph", "running"],
    title: "Open Fleet",
    description: "Your computers and what runs on them",
    icon: <WaypointsIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "navigate.fleet",
    run: async () => {
      await navigate({ to: "/fleet" });
    },
  });

  // Only where a connected computer runs scheduled tasks, like the rail's button.
  if (scheduledTaskEnvironments.length > 0) {
    actionItems.push({
      kind: "action",
      value: "action:scheduled",
      searchTerms: ["scheduled", "schedule", "tasks", "automations", "cron", "recurring", "daily"],
      title: "Open Scheduled",
      description: "Tasks agents start at set times",
      icon: <CalendarClockIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "navigate.scheduled",
      run: async () => {
        await navigate({ to: "/scheduled" });
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:new-scheduled-task",
      searchTerms: ["new scheduled task", "schedule", "automation", "cron", "recurring"],
      title: "New scheduled task",
      icon: <CalendarPlusIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/scheduled", search: { view: "new" } });
      },
    });
  }
  if (thisComputerNaming) {
    actionItems.push({
      kind: "action",
      value: "action:rename-computer",
      searchTerms: ["rename computer", "computer name", "name this computer", "fleet", "device"],
      title: "Rename this computer",
      description: `Now called ${thisComputerNaming.label}`,
      icon: <PencilIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openComputerRenameDialog(thisComputerNaming);
      },
    });
  }
  actionItems.push({
    kind: "action",
    value: "action:whats-new",
    searchTerms: ["what's new", "whats new", "changelog", "release notes", "version", "update"],
    title: "What's new in Threadlines",
    description: `The notes for v${APP_VERSION}`,
    icon: <CircleArrowUpIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      openWhatsNewDialog();
    },
  });
  actionItems.push({
    kind: "action",
    value: "action:report-problem",
    searchTerms: ["report a problem", "report", "bug", "issue", "feedback", "github", "crash"],
    title: "Report a problem",
    description: "Write a bug report and post it to GitHub",
    icon: <MessageCircleWarningIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      openReportProblemDialog();
    },
  });
  actionItems.push({
    kind: "action",
    value: "action:connect-computer",
    searchTerms: ["connect", "computer", "add computer", "pair", "code", "ssh", "link computers"],
    title: "Connect to a computer",
    description: "Use projects from another computer that runs Threadlines",
    icon: <LaptopIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      openConnectComputerDialog();
    },
  });

  if (managesOutsideAgents) {
    actionItems.push({
      kind: "action",
      value: "action:connect-agent",
      searchTerms: [
        "connect an agent",
        "outside agent",
        "mcp",
        "claude code",
        "codex",
        "gemini",
        "cursor",
        "terminal",
      ],
      title: "Connect an agent",
      description: "Let an agent you run outside Threadlines use it",
      icon: <PlugIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/settings/connections", search: { section: "agents" } });
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:connect-assistant",
      searchTerms: [
        "connect an assistant",
        "assistant",
        "always-on",
        "grok bot",
        "dots",
        "muse",
        "claude duet",
        "connector",
        "sign-in code",
        "key",
      ],
      title: "Connect an assistant",
      description: "Show a code for an always-on assistant to sign in with",
      icon: <CloudIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        // The Assistants group shows the code, or why there isn't one.
        void startAssistantCode();
        await navigate({ to: "/settings/connections", search: { section: "assistants" } });
      },
    });
  }

  // Each computer's Fleet page, once there is more than one to choose from.
  if (addProjectEnvironmentOptions.length > 1) {
    for (const option of addProjectEnvironmentOptions) {
      actionItems.push({
        kind: "action",
        value: `action:fleet-computer:${option.environmentId}`,
        searchTerms: ["fleet", "computer", "link", "unlink", option.label],
        title: `Open ${option.label} in Fleet`,
        icon: <WaypointsIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          await navigate({
            to: "/fleet/$environmentId",
            params: { environmentId: option.environmentId },
          });
        },
      });
    }
  }

  // The thread list beside the rail; a phone shows it as a sheet instead.
  if (!isMobile) {
    actionItems.push({
      kind: "action",
      value: "action:toggle-sidebar",
      searchTerms: ["sidebar", "thread list", "hide", "show", "toggle", "rail"],
      title: sidebarListOpen ? "Hide sidebar" : "Show sidebar",
      icon: sidebarListOpen ? (
        <PanelLeftCloseIcon className={ITEM_ICON_CLASS} />
      ) : (
        <PanelLeftIcon className={ITEM_ICON_CLASS} />
      ),
      shortcutCommand: "sidebar.toggle",
      run: async () => {
        useUiStateStore.getState().toggleSidebarListShown();
      },
    });
  }

  // Registered only where the rail's button is: an action that lands on
  // "unsupported" is worse than one the palette never offers.
  if (pullRequestEnvironments.length > 0) {
    actionItems.push({
      kind: "action",
      value: "action:pull-requests",
      searchTerms: ["pull requests", "prs", "pr", "reviews", "github"],
      title: "Open pull requests",
      icon: <GitPullRequestIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/pull-requests", search: { state: "open" } });
      },
    });
  }

  // Only where there is one to open: an action that lands on "this branch has
  // no pull request" is a dead end the palette should not offer.
  if (activeThreadPullRequest && activeThread) {
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    const pullRequestNumber = activeThreadPullRequest.number;
    actionItems.push({
      kind: "action",
      value: "action:thread-pull-request",
      searchTerms: ["pull request", "pr", "review", "github", `#${activeThreadPullRequest.number}`],
      title: `Open pull request #${activeThreadPullRequest.number}`,
      icon: <GitPullRequestIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        focusRightPanelTab(scopedThreadKey(threadRef), "pullRequest");
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
          search: (previous) => pullRequestTabSearchParams(previous, pullRequestNumber),
        });
      },
    });
  }

  // A project thread on a computer whose server has devices: the same rule as
  // the Device tab itself (availableRightPanelTabs).
  if (
    activeThread &&
    activeThreadProject !== null &&
    activeThreadProject.kind !== "general-chat" &&
    environmentSupportsDevices(activeThread.environmentId)
  ) {
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    actionItems.push({
      kind: "action",
      value: "action:thread-device",
      searchTerms: ["device", "simulator", "emulator", "ios", "android", "phone"],
      title: "Open device",
      icon: <SmartphoneIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        focusRightPanelTab(scopedThreadKey(threadRef), "device");
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
          search: (previous) => rightPanelTabSearchParams(previous, "device"),
        });
      },
    });
  }

  // Where find in chat can open: a saved chat on screen, off phones.
  if (chatFindAvailable) {
    actionItems.push({
      kind: "action",
      value: "action:find-in-chat",
      searchTerms: ["find in chat", "find", "search this chat", "search messages", "ctrl f"],
      title: "Find in chat",
      description: "Search this chat's messages",
      icon: <SearchIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "chat.find",
      run: async () => {
        // After the palette has closed and handed focus back, so the bar's
        // field keeps it.
        window.requestAnimationFrame(() => useChatFindStore.getState().requestOpen(null));
      },
    });
  }

  // A screenshot of a window or part of the screen, added to the message being
  // written. The desktop app only; it used to sit in the composer's "+" menu.
  if (
    (activeThread || activeDraftThread) &&
    typeof window.desktopBridge?.captureScreenshot === "function"
  ) {
    actionItems.push({
      kind: "action",
      value: "action:capture-screenshot",
      searchTerms: ["screenshot", "capture", "screen", "image", "attach", "picture"],
      title: "Capture screenshot",
      description: "Add a screenshot to the message you're writing",
      icon: <CameraIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        // After the palette has closed and handed focus back to the composer.
        window.requestAnimationFrame(() =>
          useComposerCommandsStore.getState().requestComposerCommand("captureScreenshot"),
        );
      },
    });
  }

  // The terminal's actions, for the thread on screen or the Terminals page
  // (its drawer does them, with the same confirmations as its own buttons).
  if (activeThread || activeDraftThread || onTerminalsPage) {
    const terminalActions: ReadonlyArray<{
      readonly kind: TerminalCommandKind;
      readonly title: string;
      readonly description: string;
      readonly searchTerms: ReadonlyArray<string>;
      readonly icon: ReactNode;
      readonly shortcutCommand?: KeybindingCommand;
    }> = [
      ...(onTerminalsPage
        ? []
        : [
            {
              kind: "toggle",
              title: "Toggle terminal",
              description: "Show or hide this thread's terminal",
              searchTerms: [
                "terminal",
                "toggle terminal",
                "show terminal",
                "hide terminal",
                "shell",
              ],
              icon: <TerminalSquareIcon className={ITEM_ICON_CLASS} />,
              shortcutCommand: "terminal.toggle",
            } as const,
          ]),
      {
        kind: "new",
        title: "New terminal tab",
        description: onTerminalsPage
          ? "Open a terminal in the project picked for new tabs"
          : "Open another terminal for this thread",
        searchTerms: ["new terminal", "terminal tab", "open terminal", "shell"],
        icon: <PlusIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "terminal.new",
      },
      {
        kind: "split",
        title: "Split terminal",
        description: "Open a terminal beside the current one",
        searchTerms: ["split terminal", "side by side", "terminal"],
        icon: <SquareSplitHorizontalIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "terminal.split",
      },
      {
        kind: "find",
        title: "Find in terminal",
        description: "Search the terminal's output",
        searchTerms: ["find in terminal", "search terminal", "terminal output", "find"],
        icon: <SearchIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "terminal.find",
      },
      {
        kind: "restart",
        title: "Restart terminal",
        description: onTerminalsPage
          ? "A new shell in the same folder, below the old output"
          : "A new shell in the thread's folder, below the old output",
        searchTerms: ["restart terminal", "reset terminal", "new shell", "terminal"],
        icon: <RotateCcwIcon className={ITEM_ICON_CLASS} />,
      },
      {
        kind: "clear",
        title: "Clear terminal output",
        description: "Empty the terminal and its saved output",
        searchTerms: ["clear terminal", "clear output", "terminal"],
        icon: <EraserIcon className={ITEM_ICON_CLASS} />,
      },
      {
        kind: "kill",
        title: "Kill terminal",
        description: "Stop the terminal's shell and close its tab",
        searchTerms: ["kill terminal", "close terminal", "stop terminal", "terminal"],
        icon: <Trash2Icon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "terminal.close",
      },
    ];
    for (const action of terminalActions) {
      actionItems.push({
        kind: "action",
        value: `action:terminal-${action.kind}`,
        searchTerms: [...action.searchTerms],
        title: action.title,
        description: action.description,
        icon: action.icon,
        ...(action.shortcutCommand ? { shortcutCommand: action.shortcutCommand } : {}),
        run: async () => {
          // After the palette has closed and handed focus back.
          window.requestAnimationFrame(() =>
            useTerminalCommandsStore.getState().requestTerminalCommand(action.kind),
          );
        },
      });
    }
  }

  // Where the composer's model picker lists agents: a thread (a new one
  // included), with rooms on, and no approval holding the composer's toolbar.
  // It opens the picker ready to add one, the same as its "Add agent" row.
  const addAgentThreadRef = !activeThreadRoomsEnabled
    ? null
    : activeThread
      ? derivePendingApprovals(activeThread.activities).length === 0
        ? scopeThreadRef(activeThread.environmentId, activeThread.id)
        : null
      : activeDraftThread
        ? scopeThreadRef(activeDraftThread.environmentId, activeDraftThread.threadId)
        : null;
  if (addAgentThreadRef !== null) {
    const threadRef = addAgentThreadRef;
    actionItems.push({
      kind: "action",
      value: "action:add-room-agent",
      searchTerms: ["add agent", "agents", "room", "model", "invite", "second opinion", "review"],
      title: "Add agent",
      description: "Bring another model into this thread",
      icon: <UsersRoundIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        useRoomRecipientStore.getState().requestAddAgent(threadRef);
      },
    });
  }

  // Where its computer can move it: one linked computer at least, and the
  // thread not already on its way. The dialog says why one can't go.
  if (activeThread && activeThreadMoveOffered) {
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    actionItems.push({
      kind: "action",
      value: "action:move-thread",
      searchTerms: ["move", "computer", "linked", "transfer", "send", "another machine"],
      title: "Move to another computer",
      description: "Move this thread and its changes to a linked computer",
      icon: <MonitorUpIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openThreadMoveDialog(threadRef);
      },
    });
  }

  if (moveThreadsOffered && primaryEnvironmentId !== null) {
    const sourceEnvironmentId = primaryEnvironmentId;
    actionItems.push({
      kind: "action",
      value: "action:move-threads",
      searchTerms: [
        "move",
        "threads",
        "computer",
        "linked",
        "shut down",
        "clear",
        "another machine",
      ],
      title: "Move threads to another computer…",
      description: "Move several of this computer's threads to a linked computer",
      icon: <MonitorUpIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openMoveThreadsDialog({ sourceEnvironmentId });
      },
    });
  }

  if (openThreadProjectRef !== null && projectSetupTargets.length > 0) {
    const projectRef = openThreadProjectRef;
    actionItems.push({
      kind: "action",
      value: "action:set-up-project-elsewhere",
      searchTerms: ["set up", "project", "computer", "clone", "copy", "another machine"],
      title: "Set up project on another computer",
      description: "Clone this project on another computer, with the ignored files you pick",
      icon: <FolderSyncIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openProjectSetupDialog({ project: projectRef });
      },
    });
  }

  if (activeThread) {
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    const inboxEntry = inboxEntries.find((entry) => entry.threadKey === scopedThreadKey(threadRef));
    const target = {
      threadRef,
      inbox: inboxEntry ? { isDone: inboxEntry.isDone, canMarkDone: inboxEntry.canMarkDone } : null,
    };
    for (const item of threadMenu.describe(target) ?? []) {
      const offered = PALETTE_THREAD_ACTIONS[item.id];
      if (!offered || item.disabled) continue;
      actionItems.push({
        kind: "action",
        value: `action:thread-${item.id}`,
        searchTerms: offered.searchTerms,
        title: offered.title ?? item.label,
        icon: offered.icon,
        run: async () => {
          await threadMenu.run(item.id, target);
        },
      });
    }
  }

  // Lead chats (docs/design/lead-chat.md): one "Go to" per project that has
  // one, and "New lead chat" for the project in scope when it has none.
  for (const project of projects) {
    const leadRef = projectLeadRef(useStore.getState(), project);
    if (leadRef === null) continue;
    actionItems.push({
      kind: "action",
      value: `action:lead-chat:${scopedThreadKey(leadRef)}`,
      searchTerms: ["lead chat", "lead", project.name],
      title: "Go to lead chat",
      description: project.name,
      icon: <CrownIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(leadRef),
        });
      },
    });
  }
  // The open thread's or draft's project (none until its computer's projects
  // load); the first project only when neither is open.
  const leadScopeProject =
    currentProjectId !== null
      ? (currentProject ?? undefined)
      : defaultProjectRef
        ? projects.find(
            (project) =>
              project.environmentId === defaultProjectRef.environmentId &&
              project.id === defaultProjectRef.projectId,
          )
        : undefined;
  if (
    leadScopeProject !== undefined &&
    leadScopeProject.kind === "workspace" &&
    environmentSupportsProjectLead(leadScopeProject.environmentId) &&
    leadSettingRefusal(leadScopeProject.environmentId) === null &&
    projectLeadRef(useStore.getState(), leadScopeProject) === null
  ) {
    actionItems.push({
      kind: "action",
      value: "action:new-lead-chat",
      searchTerms: ["new lead chat", "lead chat", "lead", "coordinate"],
      title: "New lead chat",
      description: leadScopeProject.name,
      icon: <CrownIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        const leadRef = await createLeadChat(leadScopeProject);
        if (leadRef !== null) {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(leadRef),
          });
        }
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:usage",
    searchTerms: ["usage", "tokens", "cost", "spend", "spending", "price", "billing"],
    title: "Open usage",
    icon: <ChartColumnIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/usage" });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:settings",
    searchTerms: ["settings", "preferences", "configuration", "keybindings"],
    title: "Open settings",
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/settings" });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:setup",
    searchTerms: ["setup", "set up", "agents", "providers", "install", "sign in", "onboarding"],
    title: "Set up agents",
    icon: <BotIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/setup" });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:community-agents",
    searchTerms: ["community", "agents", "add agent", "install agent", "acp", "registry"],
    title: "Browse community agents",
    icon: <BotIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/settings/providers", search: { section: "community" } });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:skills",
    searchTerms: ["skills", "plugins", "extensions", "agents", "capabilities"],
    title: "Open skills",
    icon: <FileTextIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/settings/plugins", search: { tab: "skills" } });
    },
  });

  const rootGroups = buildRootGroups({ actionItems, recentThreadItems });
  const activeGroups = currentView
    ? currentView.groups.map((group) => ({
        ...group,
        items: applyThreadContentSearchMatches({
          items: group.items,
          matches: threadContentMatches,
          query: deferredQuery,
        }),
      }))
    : rootGroups;

  const filteredGroups = filterCommandPaletteGroups({
    activeGroups,
    query: deferredQuery,
    isInSubmenu: currentView !== null,
    projectSearchItems: projectSearchItems,
    threadSearchItems: allThreadSearchItems,
  });

  // A typed path adds one row above the results that opens Add project there.
  // The search itself carries on underneath, so the field never turns into a
  // form.
  const addProjectPathItem: CommandPaletteActionItem | null =
    currentView === null && isFilesystemBrowseQuery(deferredQuery, addProjectPathPlatform)
      ? {
          kind: "action",
          value: "action:add-project-at-path",
          searchTerms: [],
          title: `Add project at ${deferredQuery.trim()}`,
          icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
          opensDialog: true,
          run: async () => {
            openAddProject({ initialPath: deferredQuery.trim(), returnFocus: focusComposer });
          },
        }
      : null;
  const displayedGroups: CommandPaletteView["groups"] = addProjectPathItem
    ? [
        { value: "add-project-path", label: "Add project", items: [addProjectPathItem] },
        ...filteredGroups,
      ]
    : filteredGroups;

  // The thread a highlighted result opens starts loading once the highlight
  // rests on it, as a pointer resting on a sidebar row does, so choosing it
  // opens a chat that is ready or already on its way.
  const highlightedThreadKey = highlightedThreadKeyOf(displayedGroups, highlightedItemValue);
  useEffect(() => {
    const ref = highlightedThreadKey ? parseScopedThreadKey(highlightedThreadKey) : null;
    return ref ? prewarmHighlightedThread(ref) : undefined;
  }, [highlightedThreadKey]);

  const isSubmenu = currentView !== null;
  const inputPlaceholder =
    currentView?.inputPlaceholder ?? getCommandPaletteInputPlaceholder(isSubmenu);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Backspace" && query === "" && isSubmenu) {
      event.preventDefault();
      popView();
    }
  }

  function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
    if (item.disabled) {
      return;
    }

    if (item.kind === "submenu") {
      pushView(item);
      return;
    }

    if (!item.keepOpen) {
      // A dialog taking over decides where focus goes when it closes, so the
      // palette leaves the composer alone on its way out.
      if (item.opensDialog) handingOverToDialogRef.current = true;
      setOpen(false);
    }
    // Every result naming a thread opens it: start its load now, so closing
    // the palette (which ends the highlight's prewarm) does not drop it.
    if (item.threadRef) {
      holdThreadDetailForOpen(scopeThreadRef(item.threadRef.environmentId, item.threadRef.id));
    }

    const execution =
      item.threadRef && item.threadContentMatch
        ? navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(
              scopeThreadRef(item.threadRef.environmentId, item.threadRef.id),
            ),
            search: (current) => ({
              ...closeRightPanelSearchParams(current),
              focusMessageId: item.threadContentMatch?.messageId,
              focusQuery: item.threadContentMatch?.query,
              focusRequest: newCommandId(),
            }),
          })
        : item.run();

    void execution.catch((error: unknown) => {
      toastManager.add(
        failureNotice({
          title: "Couldn't run the command",
          error,
        }),
      );
    });
  }

  return (
    <CommandDialogPopup
      aria-label="Command palette"
      className="overflow-hidden p-0"
      data-testid="command-palette"
      finalFocus={() => {
        if (handingOverToDialogRef.current) return false;
        composerHandleRef?.current?.focusAtEnd();
        return false;
      }}
      onBackdropPointerDown={() => {
        setOpen(false);
      }}
    >
      <Command
        key={viewStack.length}
        aria-label="Command palette"
        autoHighlight="always"
        mode="none"
        onItemHighlighted={(value) => {
          setHighlightedItemValue(typeof value === "string" ? value : null);
        }}
        onValueChange={handleQueryChange}
        value={query}
      >
        <CommandInput
          placeholder={inputPlaceholder}
          wrapperClassName={
            isSubmenu ? "[&_[data-slot=autocomplete-start-addon]]:pointer-events-auto" : undefined
          }
          {...(isSubmenu
            ? {
                startAddon: (
                  <button
                    type="button"
                    className="flex cursor-pointer items-center"
                    aria-label="Back"
                    onClick={popView}
                  >
                    <ArrowLeftIcon />
                  </button>
                ),
              }
            : {})}
          onKeyDown={handleKeyDown}
        />
        <CommandPanel className="max-h-[min(28rem,70vh)]">
          <CommandPaletteResults
            groups={displayedGroups}
            highlightedItemValue={highlightedItemValue}
            isActionsOnly={isActionsOnly}
            keybindings={keybindings}
            query={deferredQuery}
            onExecuteItem={executeItem}
          />
        </CommandPanel>
        <CommandFooter className="gap-3 max-sm:flex-col max-sm:items-start">
          <div className="flex items-center gap-3">
            <KbdGroup className="items-center gap-1.5">
              <Kbd>
                <ArrowUpIcon />
              </Kbd>
              <Kbd>
                <ArrowDownIcon />
              </Kbd>
              <span className={cn("text-muted-foreground/80")}>Navigate</span>
            </KbdGroup>
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Enter</Kbd>
              <span className={cn("text-muted-foreground/80")}>Select</span>
            </KbdGroup>
            {isSubmenu ? (
              <KbdGroup className="items-center gap-1.5">
                <Kbd>Backspace</Kbd>
                <span className={cn("text-muted-foreground/80")}>Back</span>
              </KbdGroup>
            ) : null}
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Esc</Kbd>
              <span className={cn("text-muted-foreground/80")}>Close</span>
            </KbdGroup>
          </div>
        </CommandFooter>
      </Command>
    </CommandDialogPopup>
  );
}
