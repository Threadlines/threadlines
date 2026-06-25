import { scopeProjectRef } from "@threadlines/client-runtime";
import { projectScriptCwd } from "@threadlines/shared/projectScripts";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";

import ChatView from "../components/ChatView";
import { ChatRightPanelInlineSidebar } from "../components/ChatRightPanelInlineSidebar";
import { threadHasPromotableServerActivity } from "../components/ChatView.logic";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../components/DiffPanelShell";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import {
  closeRightPanelSearchParams,
  type DiffRouteSearch,
  isSourceControlPanelOpen,
  parseDiffRouteSearch,
  stripRightPanelSearchParams,
} from "../diffRouteSearch";
import { preloadDiffPanel, schedulePreloadDiffPanel } from "../diffPanelPreload";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useSettings } from "../hooks/useSettings";
import { gitWorkingTreeDiffQueryOptions } from "../lib/gitReactQuery";
import {
  RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY,
  useAutoHideSourceControlSheet,
} from "../rightPanelLayout";
import { selectEnvironmentState, selectThreadExistsByRef, useStore } from "../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteRef, buildThreadRouteParams } from "../threadRoutes";
import { RightPanelSheet } from "../components/RightPanelSheet";
import { SidebarInset } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import {
  SourceControlPanel,
  type SourceControlProjectTarget,
} from "../components/source-control/SourceControlPanel";

const DiffPanel = lazy(() => import("../components/DiffPanel"));

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
}) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
        <DiffPanel mode={props.mode} onBackToSourceControl={props.onBackToSourceControl} />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
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
  const rawSourceControlOpen = isSourceControlPanelOpen(search, {
    defaultOpen: !shouldUseDiffSheet,
  });
  const sourceControlThread = serverThread ?? draftThread;
  const sourceControlProjectRef = sourceControlThread
    ? scopeProjectRef(sourceControlThread.environmentId, sourceControlThread.projectId)
    : null;
  const activeProject = useStore(
    useMemo(() => createProjectSelectorByRef(sourceControlProjectRef), [sourceControlProjectRef]),
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const sourceControlTarget = useMemo<SourceControlProjectTarget | null>(() => {
    if (!threadRef || !sourceControlThread || !activeProject) {
      return null;
    }

    return {
      environmentId: threadRef.environmentId,
      cwd: projectScriptCwd({
        project: { cwd: activeProject.cwd },
        worktreePath: sourceControlThread.worktreePath ?? null,
      }),
      name: activeProject.name,
      environmentLabel: null,
      worktreePath: sourceControlThread.worktreePath ?? null,
    };
  }, [activeProject, sourceControlThread, threadRef]);
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
  const currentThreadKey = threadRef ? `${threadRef.environmentId}:${threadRef.threadId}` : null;
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
  const sourceControlAutoHidden = useAutoHideSourceControlSheet({
    enabled: shouldUseDiffSheet,
    resetKey: currentThreadKey,
    sourceControl: search.sourceControl,
    blocked: diffOpen,
    onAutoHide: closeRightPanel,
  });
  const sourceControlOpen = rawSourceControlOpen && !sourceControlAutoHidden;
  const rightPanelOpen = diffOpen || sourceControlOpen;
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
    [markDiffOpened, navigate, threadRef],
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
    return null;
  }

  const shouldRenderDiffContent = diffOpen || hasOpenedDiff || diffPanelWarm;
  // Source control and the diff stay mounted side by side (display-toggled)
  // so swapping between them never drops worker pools, highlight caches, or
  // scroll state, and the return trip is instant.
  const rightPanelContent =
    sourceControlOpen || diffOpen ? (
      <>
        <div
          className={cn(
            "h-full w-full min-w-0 flex-col",
            sourceControlOpen && !diffOpen ? "flex" : "hidden",
          )}
        >
          <SourceControlPanel
            target={sourceControlTarget}
            activeThreadRef={threadRef}
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
          onClose={closeRightPanel}
          onOpenSourceControl={openSourceControl}
        >
          {rightPanelContent}
        </ChatRightPanelInlineSidebar>
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
        onClose={closeRightPanel}
        size={sourceControlOpen && !diffOpen ? "sourceControl" : "default"}
      >
        {rightPanelContent}
      </RightPanelSheet>
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
