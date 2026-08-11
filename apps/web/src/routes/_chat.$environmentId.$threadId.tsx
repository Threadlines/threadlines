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
  closeAgentsPanelSearchParams,
  closeRightPanelSearchParams,
  type DiffRouteSearch,
  parseDiffRouteSearch,
  stripRightPanelSearchParams,
} from "../diffRouteSearch";
import { AgentsPanel } from "../components/chat/AgentsPanel";
import { ChatRailTabs, type ChatRailTabDescriptor } from "../components/chat/ChatRailTabs";
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
  rememberedRightPanelTab,
  useAgentsPanelOpen,
  useAutoHideRightPanelSheet,
  useSourceControlPanelOpen,
  type RightPanelTab,
} from "../rightPanelLayout";
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

const LazyDiffPanelWithBack = (props: {
  mode: DiffPanelMode;
  onBackToSourceControl: () => void;
  onClose: () => void;
}) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
        <DiffPanel
          mode={props.mode}
          onBackToSourceControl={props.onBackToSourceControl}
          onClose={props.onClose}
        />
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
  const diffOpen = search.diff === "1";
  const currentThreadKey = threadRef ? `${threadRef.environmentId}:${threadRef.threadId}` : null;
  const rawSourceControlOpen = useSourceControlPanelOpen(search, currentThreadKey);
  const rawAgentsOpen = useAgentsPanelOpen(search, currentThreadKey);
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

  const [diffPanelMountState, setDiffPanelMountState] = useState(() => ({
    threadKey: currentThreadKey,
    hasOpenedDiff: diffOpen,
    warm: false,
  }));
  const hasOpenedDiff =
    diffPanelMountState.threadKey === currentThreadKey
      ? diffPanelMountState.hasOpenedDiff
      : diffOpen;
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
  const closeRightPanel = useCallback(() => {
    if (!threadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => closeRightPanelSearchParams(previous),
    });
  }, [navigate, threadRef]);
  const closeAgentsPanel = useCallback(() => {
    if (!threadRef) {
      return;
    }
    void navigate({
      replace: true,
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => closeAgentsPanelSearchParams(previous),
    });
  }, [navigate, threadRef]);
  const openAgentsPanel = useCallback(() => {
    if (!threadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => ({
        ...stripRightPanelSearchParams(previous),
        agents: "1",
        // Explicit, not just stripped: source control's remembered state (or
        // its default-open setting) would otherwise reclaim the rail.
        sourceControl: "0",
      }),
    });
  }, [navigate, threadRef]);
  const sourceControlAutoHidden = useAutoHideRightPanelSheet({
    enabled: shouldUseDiffSheet,
    resetKey: currentThreadKey,
    panelState: search.sourceControl,
    blocked: diffOpen,
    onAutoHide: closeRightPanel,
  });
  const agentsAutoHidden = useAutoHideRightPanelSheet({
    enabled: shouldUseDiffSheet,
    resetKey: currentThreadKey,
    panelState: search.agents,
    blocked: diffOpen,
    onAutoHide: closeAgentsPanel,
  });
  const agentsOpen = rawAgentsOpen && !agentsAutoHidden;
  const sourceControlOpen =
    rawSourceControlOpen && !sourceControlAutoHidden && !isGeneralChatThread && !agentsOpen;
  const rightPanelOpen = diffOpen || sourceControlOpen || agentsOpen;
  // A published source outlives the navigation for a frame or two, so the rail
  // only trusts one that names the thread it is rendering.
  const agentsSource =
    agentsPanelSource && agentsPanelSource.threadId === threadRef?.threadId
      ? agentsPanelSource
      : null;
  // The slot's own dismissals (backdrop press, rail collapse) have to close
  // whichever panel is actually showing, or the URL and the slot disagree.
  const rightPanelCloseForLayout = useCallback(() => {
    if (agentsOpen) {
      closeAgentsPanel();
      return;
    }
    closeRightPanel();
  }, [agentsOpen, closeAgentsPanel, closeRightPanel]);
  const openSourceControl = useCallback(() => {
    if (!threadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => ({
        ...stripRightPanelSearchParams(previous),
        sourceControl: "1",
        // Explicit, not just stripped: the agents panel's per-thread memory
        // would otherwise reopen it and keep suppressing source control.
        agents: "0",
      }),
    });
  }, [navigate, threadRef]);
  const openDiff = useCallback(
    (options?: {
      readonly filePath?: string;
      readonly sourceControlReturn?: boolean;
      readonly workingTree?: boolean;
    }) => {
      if (!threadRef) {
        return;
      }
      if (options?.workingTree && sourceControlTarget) {
        void invalidateGitWorkingTreeDiffQueries(queryClient, sourceControlTarget);
      }
      markDiffOpened();
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        search: (previous) => ({
          ...stripRightPanelSearchParams(previous),
          diff: "1",
          ...(options?.workingTree ? { diffMode: "workingTree" } : {}),
          ...(options?.sourceControlReturn ? { sourceControlReturn: "1" } : {}),
          ...(options?.filePath ? { diffFilePath: options.filePath } : {}),
        }),
      });
    },
    [markDiffOpened, navigate, queryClient, sourceControlTarget, threadRef],
  );

  // Which tab the rail is showing, and which tabs it offers. General Chats
  // have no source control at all, so there the rail is Agents alone — and a
  // one-tab rail keeps the panel's own title instead of a tab row.
  const activeRailTab: RightPanelTab = agentsOpen ? "agents" : "sourceControl";
  const railTabs = useMemo<ReadonlyArray<ChatRailTabDescriptor>>(() => {
    const agentsTab: ChatRailTabDescriptor = {
      id: "agents",
      label: "Agents",
      live: agentsSource ? hasRunningAgentActivity(agentsSource) : false,
    };
    return isGeneralChatThread
      ? [agentsTab]
      : [agentsTab, { id: "sourceControl", label: "Changes" }];
  }, [agentsSource, isGeneralChatThread]);
  const selectRailTab = useCallback(
    (tab: RightPanelTab) => {
      if (tab === "agents") {
        openAgentsPanel();
        return;
      }
      openSourceControl();
    },
    [openAgentsPanel, openSourceControl],
  );
  // The rail handle (and the header toggle's route-side twin) reopens the rail
  // the way this thread was left, falling back to Changes.
  const openRail = useCallback(() => {
    const remembered = rememberedRightPanelTab(currentThreadKey);
    selectRailTab(isGeneralChatThread ? "agents" : (remembered ?? "sourceControl"));
  }, [currentThreadKey, isGeneralChatThread, selectRailTab]);
  const railTitleSlot =
    railTabs.length > 1 ? (
      <ChatRailTabs tabs={railTabs} activeTab={activeRailTab} onSelectTab={selectRailTab} />
    ) : undefined;

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

  const shouldRenderDiffContent = diffOpen || hasOpenedDiff || diffPanelWarm;
  // Source control and the diff stay mounted side by side (display-toggled)
  // so swapping between them never drops worker pools, highlight caches, or
  // scroll state, and the return trip is instant.
  const rightPanelContent =
    sourceControlOpen || diffOpen || agentsOpen ? (
      <>
        {agentsOpen ? (
          <div className="flex h-full w-full min-w-0 flex-col">
            <AgentsPanel
              environmentId={threadRef.environmentId}
              threadId={threadRef.threadId}
              subagents={agentsSource?.subagents ?? EMPTY_SUBAGENTS}
              backgroundRuns={agentsSource?.backgroundRuns ?? EMPTY_BACKGROUND_RUNS}
              providerLabel={agentsSource?.providerLabel}
              threadCwd={agentsSource?.threadCwd}
              titleSlot={railTitleSlot}
              onToggleBackgroundRunTerminal={
                agentsSource?.onToggleBackgroundRunTerminal ?? noopToggleTerminal
              }
              onStopBackgroundRun={agentsSource?.onStopBackgroundRun ?? noopStopRun}
              onClose={closeAgentsPanel}
            />
          </div>
        ) : null}
        <div
          className={cn(
            "h-full w-full min-w-0 flex-col",
            sourceControlOpen && !diffOpen ? "flex" : "hidden",
          )}
        >
          <SourceControlPanel
            target={sourceControlTarget}
            activeThreadRef={threadRef}
            titleSlot={railTitleSlot}
            onClose={closeRightPanel}
            onPrefetchDiff={prefetchWorkingTreeDiff}
            onOpenDiff={(filePath?: string) => {
              openDiff({
                ...(filePath ? { filePath } : {}),
                sourceControlReturn: true,
                workingTree: true,
              });
            }}
            {...(!serverThread && draftThread
              ? { onActiveBranchChange: handleDraftSourceControlBranchChange }
              : {})}
          />
        </div>
        {shouldRenderDiffContent ? (
          <div className={cn("h-full w-full min-w-0 flex-col", diffOpen ? "flex" : "hidden")}>
            <LazyDiffPanelWithBack
              mode={shouldUseDiffSheet ? "sheet" : "sidebar"}
              onBackToSourceControl={openSourceControl}
              onClose={closeRightPanel}
            />
          </div>
        ) : null}
      </>
    ) : null;

  if (!shouldUseDiffSheet) {
    return (
      <>
        <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            onDiffPanelOpen={markDiffOpened}
            reserveTitleBarControlInset={!rightPanelOpen}
            routeKind="server"
          />
        </SidebarInset>
        <ChatRightPanelInlineSidebar
          open={rightPanelOpen}
          onClose={rightPanelCloseForLayout}
          onRequestOpen={openRail}
        >
          {rightPanelContent}
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
        open={rightPanelOpen}
        onClose={rightPanelCloseForLayout}
        size={diffOpen ? "default" : "rail"}
      >
        {rightPanelContent}
      </RightPanelSheet>
      <LazyFileViewerOverlay />
    </>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  search: {
    middlewares: [
      retainSearchParams<DiffRouteSearch>([
        "diff",
        "diffMode",
        "sourceControlReturn",
        "diffTurnId",
        "diffFilePath",
      ]),
    ],
  },
  component: ChatThreadRouteView,
});
