import { scopeProjectRef } from "@t3tools/client-runtime";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";

import ChatView from "../components/ChatView";
import {
  ChatRightPanelInlineSidebar,
  RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY,
} from "../components/ChatRightPanelInlineSidebar";
import { threadHasStarted } from "../components/ChatView.logic";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../components/DiffPanelShell";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import {
  type DiffRouteSearch,
  parseDiffRouteSearch,
  stripRightPanelSearchParams,
} from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { selectEnvironmentState, selectThreadExistsByRef, useStore } from "../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteRef, buildThreadRouteParams } from "../threadRoutes";
import { RightPanelSheet } from "../components/RightPanelSheet";
import { SidebarInset } from "~/components/ui/sidebar";
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
  showBackToSourceControl: boolean;
  onBackToSourceControl: () => void;
}) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
        <DiffPanel
          mode={props.mode}
          showBackToSourceControl={props.showBackToSourceControl}
          onBackToSourceControl={props.onBackToSourceControl}
        />
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
  const serverThreadStarted = threadHasStarted(serverThread);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;
  const diffOpen = search.diff === "1";
  const sourceControlOpen = search.sourceControl === "1";
  const rightPanelOpen = diffOpen || sourceControlOpen;
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
  const shouldUseDiffSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const currentThreadKey = threadRef ? `${threadRef.environmentId}:${threadRef.threadId}` : null;
  const [diffPanelMountState, setDiffPanelMountState] = useState(() => ({
    threadKey: currentThreadKey,
    hasOpenedDiff: diffOpen,
  }));
  const hasOpenedDiff =
    diffPanelMountState.threadKey === currentThreadKey
      ? diffPanelMountState.hasOpenedDiff
      : diffOpen;
  const markDiffOpened = useCallback(() => {
    setDiffPanelMountState((previous) => {
      if (previous.threadKey === currentThreadKey && previous.hasOpenedDiff) {
        return previous;
      }
      return {
        threadKey: currentThreadKey,
        hasOpenedDiff: true,
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
      search: (previous) => stripRightPanelSearchParams(previous),
    });
  }, [navigate, threadRef]);
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

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) {
      return;
    }

    if (!routeThreadExists && environmentHasAnyThreads) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, routeThreadExists, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread?.promotedTo) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread?.promotedTo, serverThreadStarted, threadRef]);

  if (!threadRef || !bootstrapComplete || !routeThreadExists) {
    return null;
  }

  const shouldRenderDiffContent = diffOpen || hasOpenedDiff;
  const rightPanelContent = sourceControlOpen ? (
    <SourceControlPanel
      target={sourceControlTarget}
      activeThreadRef={threadRef}
      {...(!serverThread && draftThread
        ? { onActiveBranchChange: handleDraftSourceControlBranchChange }
        : {})}
      {...(serverThread
        ? {
            onOpenDiff: (filePath?: string) => {
              openDiff({
                ...(filePath ? { filePath } : {}),
                sourceControlReturn: true,
                workingTree: true,
              });
            },
          }
        : {})}
    />
  ) : shouldRenderDiffContent ? (
    <LazyDiffPanelWithBack
      mode={shouldUseDiffSheet ? "sheet" : "sidebar"}
      showBackToSourceControl={search.sourceControlReturn === "1"}
      onBackToSourceControl={openSourceControl}
    />
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
      <RightPanelSheet open={rightPanelOpen} onClose={closeRightPanel}>
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
        "sourceControl",
        "sourceControlReturn",
        "diffTurnId",
        "diffFilePath",
      ]),
    ],
  },
  component: ChatThreadRouteView,
});
