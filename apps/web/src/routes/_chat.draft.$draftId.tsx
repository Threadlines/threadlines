import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";
import ChatView from "../components/ChatView";
import { threadHasPromotableServerActivity } from "../components/ChatView.logic";
import {
  ChatRightPanelInlineSidebar,
  RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY,
} from "../components/ChatRightPanelInlineSidebar";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import {
  type DiffRouteSearch,
  parseDiffRouteSearch,
  stripRightPanelSearchParams,
} from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
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
  const sourceControlOpen = search.sourceControl === "1";
  const shouldUseSourceControlSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
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
      search: (previous) => stripRightPanelSearchParams(previous),
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
  const handleSourceControlBranchChange = useCallback(
    (branch: string | null, worktreePath: string | null) => {
      setDraftThreadContext(draftId, { branch, worktreePath });
    },
    [draftId, setDraftThreadContext],
  );

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(canonicalThreadRef),
      search: () => (sourceControlOpen ? { sourceControl: "1" as const } : {}),
      replace: true,
    });
  }, [canonicalThreadRef, navigate, sourceControlOpen]);

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
  search: {
    middlewares: [retainSearchParams<DiffRouteSearch>(["sourceControl"])],
  },
  component: DraftChatThreadRouteView,
});
