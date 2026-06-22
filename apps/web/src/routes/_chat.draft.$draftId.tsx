import { scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import { projectScriptCwd } from "@threadlines/shared/projectScripts";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";
import ChatView from "../components/ChatView";
import { threadHasPromotableServerActivity } from "../components/ChatView.logic";
import {
  ChatRightPanelInlineSidebar,
  RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY,
} from "../components/ChatRightPanelInlineSidebar";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import {
  closeRightPanelSearchParams,
  isSourceControlPanelOpen,
  parseDiffRouteSearch,
  stripRightPanelSearchParams,
} from "../diffRouteSearch";
import { preloadDiffPanel, schedulePreloadDiffPanel } from "../diffPanelPreload";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useSettings } from "../hooks/useSettings";
import { gitWorkingTreeDiffQueryOptions } from "../lib/gitReactQuery";
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
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  resolveDraftCanonicalThreadRef,
} from "../threadRoutes";

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
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
  const sourceControlOpen = isSourceControlPanelOpen(search, {
    defaultOpen: !shouldUseSourceControlSheet,
  });
  const draftProjectRef = draftSession
    ? scopeProjectRef(draftSession.environmentId, draftSession.projectId)
    : null;
  const draftProject = useStore(
    useMemo(() => createProjectSelectorByRef(draftProjectRef), [draftProjectRef]),
  );
  const draftThreadRef = serverThreadRef;
  const sourceControlTarget = useMemo<SourceControlProjectTarget | null>(() => {
    if (!draftSession || !draftProject) {
      return null;
    }

    return {
      environmentId: draftSession.environmentId,
      cwd: projectScriptCwd({
        project: { cwd: draftProject.cwd },
        worktreePath: draftSession.worktreePath,
      }),
      name: draftProject.name,
      environmentLabel: null,
      worktreePath: draftSession.worktreePath,
    };
  }, [draftProject, draftSession]);
  const closeRightPanel = useCallback(() => {
    void navigate({
      to: "/draft/$draftId",
      params: buildDraftThreadRouteParams(draftId),
      search: (previous) => closeRightPanelSearchParams(previous),
    });
  }, [draftId, navigate]);
  const openSourceControl = useCallback(() => {
    void navigate({
      to: "/draft/$draftId",
      params: buildDraftThreadRouteParams(draftId),
      search: (previous) => ({
        ...stripRightPanelSearchParams(previous),
        sourceControl: "1",
      }),
    });
  }, [draftId, navigate]);
  const openDiff = useCallback(
    (filePath?: string) => {
      if (!serverThreadRef) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(serverThreadRef),
        search: () => ({
          diff: "1" as const,
          diffMode: "workingTree" as const,
          sourceControlReturn: "1" as const,
          ...(filePath ? { diffFilePath: filePath } : {}),
        }),
      });
    },
    [navigate, serverThreadRef],
  );
  const handleSourceControlBranchChange = useCallback(
    (branch: string | null, worktreePath: string | null) => {
      setDraftThreadContext(draftId, { branch, worktreePath });
    },
    [draftId, setDraftThreadContext],
  );
  const diffIgnoreWhitespace = useSettings((settings) => settings.diffIgnoreWhitespace);
  const queryClient = useQueryClient();
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

  const sourceControlPanel = sourceControlOpen ? (
    <SourceControlPanel
      target={sourceControlTarget}
      activeThreadRef={draftThreadRef}
      onActiveBranchChange={handleSourceControlBranchChange}
      onOpenDiff={openDiff}
      onPrefetchDiff={prefetchWorkingTreeDiff}
    />
  ) : null;

  if (!shouldUseSourceControlSheet) {
    return (
      <>
        <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
          <ChatView
            draftId={draftId}
            environmentId={draftSession.environmentId}
            threadId={draftSession.threadId}
            reserveTitleBarControlInset={!sourceControlOpen}
            routeKind="draft"
          />
        </SidebarInset>
        <ChatRightPanelInlineSidebar
          open={sourceControlOpen}
          onClose={closeRightPanel}
          onOpenSourceControl={openSourceControl}
        >
          {sourceControlPanel}
        </ChatRightPanelInlineSidebar>
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
      <RightPanelSheet open={sourceControlOpen} onClose={closeRightPanel}>
        {sourceControlPanel}
      </RightPanelSheet>
    </>
  );
}

export const Route = createFileRoute("/_chat/draft/$draftId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  component: DraftChatThreadRouteView,
});
