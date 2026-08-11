import { scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import { projectScriptCwd } from "@threadlines/shared/projectScripts";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useEffect, useMemo } from "react";
import ChatView from "../components/ChatView";
import { threadHasPromotableServerActivity } from "../components/ChatView.logic";
import { ChatRightPanelInlineSidebar } from "../components/ChatRightPanelInlineSidebar";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { parseDiffRouteSearch } from "../diffRouteSearch";
import {
  activeRightPanelTabFromSearch,
  availableRightPanelTabs,
  closeRightPanelTab,
  focusRightPanelTab,
  hideRightPanel,
  isRightPanelClosedInSearch,
  useReconciledRightPanelTabs,
  rightPanelDiffTargetFromSearch,
  rightPanelTabSearchParams,
  showRightPanel,
  type RightPanelDiffTarget,
  type RightPanelTab,
} from "../rightPanelTabs";
import { ChatRightPanel } from "../components/ChatRightPanel";
import { cn } from "../lib/utils";
import { preloadDiffPanel, schedulePreloadDiffPanel } from "../diffPanelPreload";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useSettings } from "../hooks/useSettings";
import {
  gitWorkingTreeDiffQueryOptions,
  invalidateGitWorkingTreeDiffQueries,
} from "../lib/gitReactQuery";
import {
  RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY,
  draftRightPanelStateKey,
  useAutoHideRightPanelSheet,
  useRightPanelDefaultVisible,
} from "../rightPanelLayout";
import { SidebarInset } from "../components/ui/sidebar";
import { RightPanelSheet } from "../components/RightPanelSheet";
import {
  SourceControlPanel,
  type SourceControlProjectTarget,
} from "../components/source-control/SourceControlPanel";
import {
  createProjectSelectorByRef,
  createThreadSelectorAcrossEnvironments,
} from "../storeSelectors";
import { useStore } from "../store";
import { setActiveFileViewerContext, useFileViewerStore } from "../fileViewerStore";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  resolveDraftCanonicalThreadRef,
} from "../threadRoutes";

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

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { draftId: rawDraftId } = Route.useParams();
  const search = Route.useSearch();
  const shouldUseSourceControlSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const draftId = DraftId.make(rawDraftId);
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const serverThread = useStore(
    useMemo(
      () => createThreadSelectorAcrossEnvironments(draftSession?.threadId ?? null),
      [draftSession?.threadId],
    ),
  );
  const serverThreadRef = useMemo(
    () => (draftSession ? scopeThreadRef(draftSession.environmentId, draftSession.threadId) : null),
    [draftSession],
  );
  const serverThreadHasTurnActivity = threadHasPromotableServerActivity(serverThread);
  const canonicalThreadRef = useMemo(
    () =>
      resolveDraftCanonicalThreadRef({
        draftPromotedTo: draftSession?.promotedTo,
        serverThreadRef: serverThreadRef && serverThread ? serverThreadRef : null,
        serverThreadHasTurnActivity,
      }),
    [draftSession?.promotedTo, serverThread, serverThreadHasTurnActivity, serverThreadRef],
  );
  const panelStateKey = draftRightPanelStateKey(draftId);
  const draftProjectRef = draftSession
    ? scopeProjectRef(draftSession.environmentId, draftSession.projectId)
    : null;
  const draftProject = useStore(
    useMemo(() => createProjectSelectorByRef(draftProjectRef), [draftProjectRef]),
  );
  const draftThreadRef = serverThreadRef;
  // General Chat drafts never expose source control, even via deep links.
  const isGeneralChatDraft = draftProject?.kind === "general-chat";
  const sourceControlTarget = useMemo<SourceControlProjectTarget | null>(() => {
    if (!draftSession || !draftProject || isGeneralChatDraft) {
      return null;
    }

    return {
      environmentId: draftSession.environmentId,
      projectCwd: draftProject.cwd,
      cwd: projectScriptCwd({
        project: { cwd: draftProject.cwd },
        worktreePath: draftSession.worktreePath,
      }),
      name: draftProject.name,
      environmentLabel: null,
      worktreePath: draftSession.worktreePath,
      // Drafts have no provider session, so no observed cwd divergence.
      effectiveCwd: null,
    };
  }, [draftProject, draftSession, isGeneralChatDraft]);
  const availableTabs = useMemo(
    // A draft has no turn yet, so no agents: its sidebar is the two git
    // surfaces. General Chat drafts have neither, and get the empty launcher.
    () => availableRightPanelTabs({ isGeneralChat: isGeneralChatDraft, isDraft: true }),
    [isGeneralChatDraft],
  );
  const defaultVisible = useRightPanelDefaultVisible();
  const urlActiveTab = activeRightPanelTabFromSearch(search);
  const urlDiffTarget = useMemo(() => rightPanelDiffTargetFromSearch(search), [search]);
  const rightPanel = useReconciledRightPanelTabs(panelStateKey, {
    urlActiveTab,
    urlClosed: isRightPanelClosedInSearch(search),
    urlDiffTarget,
    availableTabs,
    defaultVisible,
  });
  const navigateToTab = useCallback(
    (tab: RightPanelTab | null) => {
      void navigate({
        replace: true,
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(draftId),
        search: (previous) => rightPanelTabSearchParams(previous, tab),
      });
    },
    [draftId, navigate],
  );
  const hideSidebar = useCallback(() => {
    hideRightPanel(panelStateKey);
    navigateToTab(null);
  }, [navigateToTab, panelStateKey]);
  const sidebarAutoHidden = useAutoHideRightPanelSheet({
    enabled: shouldUseSourceControlSheet,
    resetKey: draftId,
    panelState: urlActiveTab !== null ? "1" : undefined,
    onAutoHide: hideSidebar,
  });
  const sidebarVisible = rightPanel.visible && !sidebarAutoHidden;
  const activeTab = sidebarVisible ? rightPanel.activeTab : null;
  const sourceControlOpen = activeTab === "sourceControl";
  const fileViewerCwd = isGeneralChatDraft
    ? draftProject && draftThreadRef
      ? `${draftProject.cwd}/threads/${draftThreadRef.threadId}`
      : null
    : (sourceControlTarget?.cwd ?? null);
  useEffect(() => {
    if (!draftThreadRef || !fileViewerCwd) {
      setActiveFileViewerContext(null);
      return;
    }
    setActiveFileViewerContext({
      environmentId: draftThreadRef.environmentId,
      cwd: fileViewerCwd,
      threadRef: draftThreadRef,
    });
    return () => {
      setActiveFileViewerContext(null);
    };
  }, [draftThreadRef, fileViewerCwd]);
  /**
   * The draft route has no diff panel of its own: the diff reads the thread's
   * checkpoints and working tree through the thread route's params, so opening
   * the Diff tab hands over to that route with the tab already active. Which is
   * what a file row here has always done.
   */
  const openDiffOnThreadRoute = useCallback(
    (target: RightPanelDiffTarget) => {
      if (!serverThreadRef) {
        return;
      }
      if (sourceControlTarget) {
        void invalidateGitWorkingTreeDiffQueries(queryClient, sourceControlTarget);
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(serverThreadRef),
        search: () => rightPanelTabSearchParams({}, "diff", target),
      });
    },
    [navigate, queryClient, serverThreadRef, sourceControlTarget],
  );
  const selectTab = useCallback(
    (tab: RightPanelTab) => {
      if (tab === "diff") {
        openDiffOnThreadRoute({ diffMode: "workingTree" });
        return;
      }
      focusRightPanelTab(panelStateKey, tab);
      navigateToTab(tab);
    },
    [navigateToTab, openDiffOnThreadRoute, panelStateKey],
  );
  const closeTab = useCallback(
    (tab: RightPanelTab) => {
      navigateToTab(closeRightPanelTab(panelStateKey, tab));
    },
    [navigateToTab, panelStateKey],
  );
  const showSidebar = useCallback(() => {
    const { activeTab: nextTab } = showRightPanel(panelStateKey, availableTabs);
    if (nextTab !== null) {
      navigateToTab(nextTab);
    }
  }, [availableTabs, navigateToTab, panelStateKey]);
  // A `diff=1` deep link (or a strip restored with Diff active) would otherwise
  // leave an empty tab here, since the diff itself lives on the thread route.
  useEffect(() => {
    if (activeTab !== "diff") {
      return;
    }
    openDiffOnThreadRoute(rightPanel.diffTarget ?? { diffMode: "workingTree" });
  }, [activeTab, openDiffOnThreadRoute, rightPanel.diffTarget]);
  const handleSourceControlBranchChange = useCallback(
    (branch: string | null, worktreePath: string | null) => {
      setDraftThreadContext(draftId, { branch, worktreePath });
    },
    [draftId, setDraftThreadContext],
  );
  const diffIgnoreWhitespace = useSettings((settings) => settings.diffIgnoreWhitespace);
  useEffect(() => {
    if (!sourceControlOpen) {
      return;
    }
    return schedulePreloadDiffPanel();
  }, [sourceControlOpen]);
  const prefetchWorkingTreeDiff = useCallback(() => {
    preloadDiffPanel();
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
  }, [diffIgnoreWhitespace, queryClient, sourceControlTarget]);

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(canonicalThreadRef),
      search: () => (search.sourceControl ? { sourceControl: search.sourceControl } : {}),
      replace: true,
    });
  }, [canonicalThreadRef, navigate, search.sourceControl]);

  useEffect(() => {
    if (draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate]);

  if (canonicalThreadRef) {
    return (
      <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
        <ChatView
          environmentId={canonicalThreadRef.environmentId}
          threadId={canonicalThreadRef.threadId}
          routeKind="server"
        />
      </SidebarInset>
    );
  }

  if (!draftSession) {
    return null;
  }

  // Hidden means gone, not merely off-canvas: a mounted Changes tab keeps
  // polling git, and neither layout unmounts its children on its own.
  const rightPanelChrome = !sidebarVisible ? null : (
    <ChatRightPanel
      openTabs={rightPanel.openTabs}
      availableTabs={availableTabs}
      activeTab={activeTab}
      onSelectTab={selectTab}
      onCloseTab={closeTab}
      {...(shouldUseSourceControlSheet ? { onDismiss: hideSidebar } : {})}
    >
      {rightPanel.openTabs.includes("sourceControl") ? (
        <div
          className={cn("h-full w-full min-w-0 flex-col", sourceControlOpen ? "flex" : "hidden")}
        >
          <SourceControlPanel
            target={sourceControlTarget}
            activeThreadRef={draftThreadRef}
            embedded
            onActiveBranchChange={handleSourceControlBranchChange}
            onOpenDiff={(filePath?: string) => {
              openDiffOnThreadRoute({
                diffMode: "workingTree",
                ...(filePath ? { diffFilePath: filePath } : {}),
              });
            }}
            onPrefetchDiff={prefetchWorkingTreeDiff}
          />
        </div>
      ) : null}
    </ChatRightPanel>
  );

  if (!shouldUseSourceControlSheet) {
    return (
      <>
        <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
          <ChatView
            draftId={draftId}
            environmentId={draftSession.environmentId}
            threadId={draftSession.threadId}
            reserveTitleBarControlInset={!sidebarVisible}
            routeKind="draft"
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
          draftId={draftId}
          environmentId={draftSession.environmentId}
          threadId={draftSession.threadId}
          routeKind="draft"
        />
      </SidebarInset>
      <RightPanelSheet open={sidebarVisible} onClose={hideSidebar} size="rail">
        {rightPanelChrome}
      </RightPanelSheet>
      <LazyFileViewerOverlay />
    </>
  );
}

export const Route = createFileRoute("/_chat/draft/$draftId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  component: DraftChatThreadRouteView,
});
