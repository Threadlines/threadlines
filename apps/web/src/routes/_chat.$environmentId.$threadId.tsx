import { scopeProjectRef } from "@threadlines/client-runtime";
import { resolveThreadWorkingCwd } from "@threadlines/shared/threadCwd";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";

import ChatView from "../components/ChatView";
import { ChatRightPanelInlineSidebar } from "../components/ChatRightPanelInlineSidebar";
import { HostedStaticLoadingState } from "../components/ConnectionStatusStates";
import { threadHasPromotableServerActivity } from "../components/ChatView.logic";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../components/DiffPanelShell";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import { useSavedEnvironmentRegistryStore } from "../environments/runtime";
import {
  closeRightPanelSearchParams,
  type DiffRouteSearch,
  parseDiffRouteSearch,
} from "../diffRouteSearch";
import { AgentsPanel } from "../components/chat/AgentsPanel";
import { ChatRightPanel } from "../components/ChatRightPanel";
import { useAgentsPanelSource } from "../agentsPanelStore";
import { preloadDiffPanel, schedulePreloadDiffPanel } from "../diffPanelPreload";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useSettings } from "../hooks/useSettings";
import {
  gitWorkingTreeDiffQueryOptions,
  invalidateGitWorkingTreeDiffQueries,
} from "../lib/gitReactQuery";
import {
  RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY,
  useAutoHideRightPanelSheet,
  useRightPanelDefaultVisible,
} from "../rightPanelLayout";
import {
  activeRightPanelTabFromSearch,
  availableRightPanelTabs,
  closeRightPanelTab,
  focusRightPanelTab,
  hideRightPanel,
  isRightPanelClosedInSearch,
  useReconciledRightPanelTabs,
  retargetRightPanelDiff,
  rightPanelDiffTargetFromSearch,
  rightPanelTabSearchParams,
  showRightPanel,
  type RightPanelDiffTarget,
  type RightPanelTab,
} from "../rightPanelTabs";
import { hasRunningAgentActivity } from "../components/chat/agentsPanel.logic";
import { selectEnvironmentState, selectThreadExistsByRef, useStore } from "../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import { setActiveFileViewerContext, useFileViewerStore } from "../fileViewerStore";
import { resolveThreadRouteRef, buildThreadRouteParams } from "../threadRoutes";
import { RightPanelSheet } from "../components/RightPanelSheet";
import { SidebarInset } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import {
  SourceControlPanel,
  type SourceControlProjectTarget,
} from "../components/source-control/SourceControlPanel";

// The rail can be opened before the chat column has published its turn state
// (or on a thread with nothing running at all), so the agents tab renders from
// these until a source for this thread arrives.
const EMPTY_SUBAGENTS = [] as const;
const EMPTY_BACKGROUND_RUNS = [] as const;
const noopToggleTerminal = () => {};
const noopStopRun = () => {};

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const FileViewerOverlay = lazy(() => import("../components/file-viewer/FileViewerOverlay"));

/** Mount the heavy viewer chunk only after the first open request. */
function LazyFileViewerOverlay() {
  const isOpen = useFileViewerStore((state) => state.isOpen);
  const hasContext = useFileViewerStore((state) => state.context !== null);
  if (!isOpen && !hasContext) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <FileViewerOverlay />
    </Suspense>
  );
}

const DiffLoadingFallback = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label="Loading diff viewer..." />
    </DiffPanelShell>
  );
};

const LazyDiffPanel = (props: {
  mode: DiffPanelMode;
  onBackToChanges: (() => void) | undefined;
}) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
        <DiffPanel mode={props.mode} embedded onBackToChanges={props.onBackToChanges} />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const { authGateState } = Route.useRouteContext();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const savedEnvironmentLabel = useSavedEnvironmentRegistryStore((state) =>
    threadRef ? (state.byId[threadRef.environmentId]?.label ?? null) : null,
  );
  const search = Route.useSearch();
  const shouldUseDiffSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const bootstrapComplete = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).bootstrapComplete,
  );
  const serverThread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const threadExists = useStore((store) => selectThreadExistsByRef(store, threadRef));
  const environmentHasServerThreads = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).threadIds.length > 0,
  );
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) => {
    if (!threadRef) {
      return false;
    }
    return store.hasDraftThreadsInEnvironment(threadRef.environmentId);
  });
  const routeThreadExists = threadExists || draftThreadExists;
  const serverThreadHasPromotableActivity = threadHasPromotableServerActivity(serverThread);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;
  const currentThreadKey = threadRef ? `${threadRef.environmentId}:${threadRef.threadId}` : null;
  const agentsPanelSource = useAgentsPanelSource();
  const sourceControlThread = serverThread ?? draftThread;
  const sourceControlProjectRef = sourceControlThread
    ? scopeProjectRef(sourceControlThread.environmentId, sourceControlThread.projectId)
    : null;
  const activeProject = useStore(
    useMemo(() => createProjectSelectorByRef(sourceControlProjectRef), [sourceControlProjectRef]),
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  // General Chat threads never expose source control, even via deep links.
  const isGeneralChatThread = activeProject?.kind === "general-chat";
  // Drafts never have a provider session, so only server threads carry an
  // observed cwd divergence (agent entered a worktree mid-session).
  const threadEffectiveCwd = serverThread?.effectiveCwd ?? null;
  const sourceControlTarget = useMemo<SourceControlProjectTarget | null>(() => {
    if (!threadRef || !sourceControlThread || !activeProject || isGeneralChatThread) {
      return null;
    }

    return {
      environmentId: threadRef.environmentId,
      projectCwd: activeProject.cwd,
      cwd: resolveThreadWorkingCwd({
        projectCwd: activeProject.cwd,
        worktreePath: sourceControlThread.worktreePath ?? null,
        effectiveCwd: threadEffectiveCwd,
      }),
      name: activeProject.name,
      environmentLabel: null,
      worktreePath: sourceControlThread.worktreePath ?? null,
      effectiveCwd: threadEffectiveCwd,
    };
  }, [activeProject, isGeneralChatThread, sourceControlThread, threadEffectiveCwd, threadRef]);
  const handleDraftSourceControlBranchChange = useCallback(
    (branch: string | null, worktreePath: string | null) => {
      if (!threadRef) {
        return;
      }
      setDraftThreadContext(threadRef, { branch, worktreePath });
    },
    [setDraftThreadContext, threadRef],
  );
  const diffIgnoreWhitespace = useSettings((settings) => settings.diffIgnoreWhitespace);
  const queryClient = useQueryClient();

  // Register the workspace context so chat file chips, diff rows, and the
  // terminal affordance can open the internal file viewer from anywhere in
  // this route without prop drilling. General Chat threads browse their
  // per-thread scratch directory (mirrors the server's provider cwd layout).
  const fileViewerCwd = isGeneralChatThread
    ? activeProject
      ? `${activeProject.cwd}/threads/${threadRef?.threadId ?? ""}`
      : null
    : (sourceControlTarget?.cwd ?? null);
  useEffect(() => {
    if (!threadRef || !fileViewerCwd) {
      setActiveFileViewerContext(null);
      return;
    }
    setActiveFileViewerContext({
      environmentId: threadRef.environmentId,
      cwd: fileViewerCwd,
      threadRef,
    });
    return () => {
      setActiveFileViewerContext(null);
    };
  }, [fileViewerCwd, threadRef]);

  const diffLinkedInUrl = search.diff === "1";
  const [diffPanelMountState, setDiffPanelMountState] = useState(() => ({
    threadKey: currentThreadKey,
    hasOpenedDiff: diffLinkedInUrl,
    warm: false,
  }));
  const hasOpenedDiff =
    diffPanelMountState.threadKey === currentThreadKey
      ? diffPanelMountState.hasOpenedDiff
      : diffLinkedInUrl;
  const diffPanelWarm =
    diffPanelMountState.threadKey === currentThreadKey ? diffPanelMountState.warm : false;
  const markDiffOpened = useCallback(() => {
    setDiffPanelMountState((previous) => {
      if (previous.threadKey === currentThreadKey && previous.hasOpenedDiff) {
        return previous;
      }
      return {
        threadKey: currentThreadKey,
        hasOpenedDiff: true,
        warm: previous.threadKey === currentThreadKey ? previous.warm : false,
      };
    });
  }, [currentThreadKey]);
  // Hover intent on a source control file row: mount the diff panel hidden so
  // the chunk, query, and highlighting are warm before the click lands.
  const markDiffWarm = useCallback(() => {
    setDiffPanelMountState((previous) => {
      if (previous.threadKey === currentThreadKey && previous.warm) {
        return previous;
      }
      return {
        threadKey: currentThreadKey,
        hasOpenedDiff: previous.threadKey === currentThreadKey ? previous.hasOpenedDiff : false,
        warm: true,
      };
    });
  }, [currentThreadKey]);
  // Navigating the sidebar is navigating its active tab: one place writes the
  // panel search params, for every entry point into the sidebar.
  const navigateToTab = useCallback(
    (tab: RightPanelTab | null, diffTarget?: RightPanelDiffTarget | null) => {
      if (!threadRef) {
        return;
      }
      void navigate({
        replace: true,
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        search: (previous) => rightPanelTabSearchParams(previous, tab, diffTarget),
      });
    },
    [navigate, threadRef],
  );

  const availableTabs = useMemo(
    () =>
      availableRightPanelTabs({
        isGeneralChat: isGeneralChatThread,
        // A thread the server has not accepted yet has no turn, so no agents.
        isDraft: !serverThread,
      }),
    [isGeneralChatThread, serverThread],
  );
  const defaultVisible = useRightPanelDefaultVisible();
  const urlActiveTab = activeRightPanelTabFromSearch(search);
  const urlClosed = isRightPanelClosedInSearch(search);
  const urlDiffTarget = useMemo(() => rightPanelDiffTargetFromSearch(search), [search]);
  // The one caller that folds the URL into the thread's remembered strip. The
  // chat header renders inside this route and reads the same store, so it sees
  // the result in the same pass.
  const rightPanel = useReconciledRightPanelTabs(currentThreadKey, {
    urlActiveTab,
    urlClosed,
    urlDiffTarget,
    availableTabs,
    defaultVisible,
  });
  const hideSidebar = useCallback(() => {
    hideRightPanel(currentThreadKey);
    navigateToTab(null);
  }, [currentThreadKey, navigateToTab]);
  // The resize handle's own reopen. Lands on the tab this thread was left on,
  // or on the launcher when nothing is open — never on a bare panel.
  const showSidebar = useCallback(() => {
    const { activeTab: nextTab, diffTarget: nextDiffTarget } = showRightPanel(
      currentThreadKey,
      availableTabs,
    );
    if (nextTab !== null) {
      navigateToTab(nextTab, nextTab === "diff" ? nextDiffTarget : null);
    }
  }, [availableTabs, currentThreadKey, navigateToTab]);
  const sidebarAutoHidden = useAutoHideRightPanelSheet({
    enabled: shouldUseDiffSheet,
    resetKey: currentThreadKey,
    panelState: urlActiveTab !== null ? "1" : undefined,
    // A diff deep link is worth landing on even where it covers the
    // conversation; the two list surfaces are not.
    blocked: urlActiveTab === "diff",
    onAutoHide: hideSidebar,
  });
  const sidebarVisible = rightPanel.visible && !sidebarAutoHidden;
  const openTabs = rightPanel.openTabs;
  const activeTab = sidebarVisible ? rightPanel.activeTab : null;
  const diffTarget = rightPanel.diffTarget;
  const diffOpen = activeTab === "diff";
  const sourceControlOpen = activeTab === "sourceControl";
  const agentsOpen = activeTab === "agents";
  // A published source outlives the navigation for a frame or two, so the rail
  // only trusts one that names the thread it is rendering.
  const agentsSource =
    agentsPanelSource && agentsPanelSource.threadId === threadRef?.threadId
      ? agentsPanelSource
      : null;
  const liveTabs = useMemo<ReadonlyArray<RightPanelTab>>(
    () => (agentsSource && hasRunningAgentActivity(agentsSource) ? ["agents"] : []),
    [agentsSource],
  );
  // Opening the Diff tab with nothing remembered means this thread's working
  // tree, which is also the freshest thing to look at, so it gets re-read.
  const activateDiffTab = useCallback(
    (target: RightPanelDiffTarget | null) => {
      const resolved: RightPanelDiffTarget = target ?? { diffMode: "workingTree" };
      if (resolved.diffMode === "workingTree" && sourceControlTarget) {
        void invalidateGitWorkingTreeDiffQueries(queryClient, sourceControlTarget);
      }
      markDiffOpened();
      retargetRightPanelDiff(currentThreadKey, resolved);
      navigateToTab("diff", resolved);
    },
    [currentThreadKey, markDiffOpened, navigateToTab, queryClient, sourceControlTarget],
  );
  const selectTab = useCallback(
    (tab: RightPanelTab) => {
      if (tab === "diff") {
        activateDiffTab(diffTarget);
        return;
      }
      focusRightPanelTab(currentThreadKey, tab);
      navigateToTab(tab);
    },
    [activateDiffTab, currentThreadKey, diffTarget, navigateToTab],
  );
  const closeTab = useCallback(
    (tab: RightPanelTab) => {
      const nextTab = closeRightPanelTab(currentThreadKey, tab);
      navigateToTab(nextTab, nextTab === "diff" ? diffTarget : null);
    },
    [currentThreadKey, diffTarget, navigateToTab],
  );
  const backToChanges = useMemo(
    () => (availableTabs.includes("sourceControl") ? () => selectTab("sourceControl") : undefined),
    [availableTabs, selectTab],
  );

  // Warm the lazy diff chunk while source control is open: a file click is
  // the most likely next action, and the Suspense skeleton reads as jank.
  useEffect(() => {
    if (!sourceControlOpen) {
      return;
    }
    return schedulePreloadDiffPanel();
  }, [sourceControlOpen]);
  const prefetchWorkingTreeDiff = useCallback(() => {
    preloadDiffPanel();
    markDiffWarm();
    if (!sourceControlTarget) {
      return;
    }
    void queryClient.prefetchQuery(
      gitWorkingTreeDiffQueryOptions({
        environmentId: sourceControlTarget.environmentId,
        cwd: sourceControlTarget.cwd,
        filePaths: null,
        ignoreWhitespace: diffIgnoreWhitespace,
      }),
    );
  }, [diffIgnoreWhitespace, markDiffWarm, queryClient, sourceControlTarget]);

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) {
      return;
    }

    if (!routeThreadExists && environmentHasAnyThreads) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, routeThreadExists, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadHasPromotableActivity || !draftThread?.promotedTo) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread?.promotedTo, serverThreadHasPromotableActivity, threadRef]);

  if (!threadRef || !bootstrapComplete || !routeThreadExists) {
    // On hosted (phone) sessions the only content source is the relay
    // bootstrap, so a refreshed deep link lands here with nothing loaded yet.
    // Rendering nothing reads as a broken empty page; show the same loading
    // surface the index route uses until the bootstrap resolves the thread.
    if (authGateState.status === "hosted-static" && !bootstrapComplete) {
      return <HostedStaticLoadingState label={savedEnvironmentLabel} />;
    }
    return null;
  }

  // Every tab in the strip stays mounted, hidden rather than unmounted, so
  // tabbing away and back never drops a list's scroll position, a worker pool
  // or a highlight cache. The diff also mounts on hover intent over a file row,
  // before its tab exists, so the chunk is warm by the time the click lands.
  const shouldRenderDiffContent = openTabs.includes("diff") || hasOpenedDiff || diffPanelWarm;
  const rightPanelContent = (
    <>
      {openTabs.includes("agents") ? (
        <div className={cn("h-full w-full min-w-0 flex-col", agentsOpen ? "flex" : "hidden")}>
          <AgentsPanel
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            subagents={agentsSource?.subagents ?? EMPTY_SUBAGENTS}
            backgroundRuns={agentsSource?.backgroundRuns ?? EMPTY_BACKGROUND_RUNS}
            providerLabel={agentsSource?.providerLabel}
            threadCwd={agentsSource?.threadCwd}
            embedded
            onToggleBackgroundRunTerminal={
              agentsSource?.onToggleBackgroundRunTerminal ?? noopToggleTerminal
            }
            onStopBackgroundRun={agentsSource?.onStopBackgroundRun ?? noopStopRun}
          />
        </div>
      ) : null}
      {openTabs.includes("sourceControl") ? (
        <div className={cn("h-full w-full min-w-0 flex-col", sourceControlOpen ? "flex" : "hidden")}>
          <SourceControlPanel
            target={sourceControlTarget}
            activeThreadRef={threadRef}
            embedded
            onPrefetchDiff={prefetchWorkingTreeDiff}
            onOpenDiff={(filePath?: string) => {
              activateDiffTab({
                diffMode: "workingTree",
                ...(filePath ? { diffFilePath: filePath } : {}),
              });
            }}
            {...(!serverThread && draftThread
              ? { onActiveBranchChange: handleDraftSourceControlBranchChange }
              : {})}
          />
        </div>
      ) : null}
      {shouldRenderDiffContent ? (
        <div className={cn("h-full w-full min-w-0 flex-col", diffOpen ? "flex" : "hidden")}>
          <LazyDiffPanel
            mode={shouldUseDiffSheet ? "sheet" : "sidebar"}
            onBackToChanges={backToChanges}
          />
        </div>
      ) : null}
    </>
  );
  // Hidden means gone, not merely off-canvas: a mounted Changes tab keeps
  // polling git, and neither layout unmounts its children on its own.
  const rightPanelChrome = !sidebarVisible ? null : (
    <ChatRightPanel
      openTabs={openTabs}
      availableTabs={availableTabs}
      activeTab={activeTab}
      liveTabs={liveTabs}
      onSelectTab={selectTab}
      onCloseTab={closeTab}
      {...(shouldUseDiffSheet ? { onDismiss: hideSidebar } : {})}
    >
      {rightPanelContent}
    </ChatRightPanel>
  );

  if (!shouldUseDiffSheet) {
    return (
      <>
        <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            onDiffPanelOpen={markDiffOpened}
            reserveTitleBarControlInset={!sidebarVisible}
            routeKind="server"
          />
        </SidebarInset>
        <ChatRightPanelInlineSidebar
          open={sidebarVisible}
          onClose={hideSidebar}
          onRequestOpen={showSidebar}
        >
          {rightPanelChrome}
        </ChatRightPanelInlineSidebar>
        <LazyFileViewerOverlay />
      </>
    );
  }

  return (
    <>
      <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          onDiffPanelOpen={markDiffOpened}
          routeKind="server"
        />
      </SidebarInset>
      <RightPanelSheet
        open={sidebarVisible}
        onClose={hideSidebar}
        size={diffOpen ? "default" : "rail"}
      >
        {rightPanelChrome}
      </RightPanelSheet>
      <LazyFileViewerOverlay />
    </>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  search: {
    middlewares: [
      retainSearchParams<DiffRouteSearch>(["diff", "diffMode", "diffTurnId", "diffFilePath"]),
    ],
  },
  component: ChatThreadRouteView,
});
