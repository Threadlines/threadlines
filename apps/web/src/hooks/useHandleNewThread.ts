import { scopedProjectKey, scopeProjectRef } from "@threadlines/client-runtime";
import { DEFAULT_RUNTIME_MODE, type ScopedProjectRef } from "@threadlines/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  composerDraftHasUserContent,
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { preserveRightPanelSearchParamsForDraftNavigation } from "../diffRouteSearch";
import { newDraftId, newThreadId } from "../lib/utils";
import {
  orderItemsByPreferredIds,
  sortScopedProjectsByActivity,
} from "../components/Sidebar.logic";
import {
  deriveLogicalProjectKeyFromSettings,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  selectWorkspaceProjectsAcrossEnvironments,
  useStore,
} from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { useSettings } from "./useSettings";

function useNewThreadState() {
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const router = useRouter();
  const getCurrentRouteTarget = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  }, [router]);

  return useCallback(
    (
      projectRef: ScopedProjectRef,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
        replace?: boolean;
      },
    ): Promise<void> => {
      const {
        adoptDraftSessionForLogicalProjectKey,
        getComposerDraft,
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
        applyStickyState,
        setDraftThreadContext,
        setLogicalProjectDraftThreadId,
      } = useComposerDraftStore.getState();
      const currentRouteTarget = getCurrentRouteTarget();
      // Read projects at call time: a project created moments ago reaches the
      // store before this callback is recreated, and a stale list here means
      // the draft is keyed to a placeholder identity.
      const projects = selectProjectsAcrossEnvironments(useStore.getState());
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      const logicalProjectKey = project
        ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
        : scopedProjectKey(projectRef);
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const storedDraftThread =
        getDraftSessionByLogicalProjectKey(logicalProjectKey) ??
        adoptDraftSessionForLogicalProjectKey(projectRef, logicalProjectKey);
      // New-thread surfaces (button, hotkeys, "/" landing, palette) only ever
      // reuse a draft the user has NOT invested in. A draft with typed text or
      // attachments is work in progress: it stays alive where it is (reachable
      // from the sidebar draft rows) and this request mints a fresh draft
      // instead — the remap in the store preserves invested drafts rather than
      // deleting them.
      const emptyStoredDraftThread =
        storedDraftThread &&
        !composerDraftHasUserContent(getComposerDraft(storedDraftThread.draftId))
          ? storedDraftThread
          : null;
      const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
        ? currentRouteTarget.kind === "server"
          ? getDraftThread(currentRouteTarget.threadRef)
          : getDraftSession(currentRouteTarget.draftId)
        : null;
      if (emptyStoredDraftThread) {
        return (async () => {
          // A reused draft can hold the model it was minted with long ago;
          // "new thread" means the last-used model, so sticky state is
          // re-applied here just as it is for a freshly minted draft.
          applyStickyState(emptyStoredDraftThread.draftId);
          if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
            setDraftThreadContext(emptyStoredDraftThread.draftId, {
              ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
              ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
              ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
            });
          }
          setLogicalProjectDraftThreadId(
            logicalProjectKey,
            projectRef,
            emptyStoredDraftThread.draftId,
            {
              threadId: emptyStoredDraftThread.threadId,
            },
          );
          if (
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === emptyStoredDraftThread.draftId
          ) {
            return;
          }
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: emptyStoredDraftThread.draftId },
            search: preserveRightPanelSearchParamsForDraftNavigation,
            replace: options?.replace ?? false,
          });
        })();
      }

      if (
        latestActiveDraftThread &&
        currentRouteTarget?.kind === "draft" &&
        latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
        latestActiveDraftThread.promotedTo == null &&
        // Same content rule as above: a new-thread request while viewing an
        // invested draft mints a fresh one instead of repurposing it.
        !composerDraftHasUserContent(getComposerDraft(currentRouteTarget.draftId))
      ) {
        applyStickyState(currentRouteTarget.draftId);
        if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
          setDraftThreadContext(currentRouteTarget.draftId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          });
        }
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
          threadId: latestActiveDraftThread.threadId,
          createdAt: latestActiveDraftThread.createdAt,
          runtimeMode: latestActiveDraftThread.runtimeMode,
          interactionMode: latestActiveDraftThread.interactionMode,
          ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
          ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
          ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
        });
        return Promise.resolve();
      }

      const draftId = newDraftId();
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
          threadId,
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: options?.envMode ?? "local",
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });
        applyStickyState(draftId);

        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
          search: preserveRightPanelSearchParamsForDraftNavigation,
          replace: options?.replace ?? false,
        });
      })();
    },
    [getCurrentRouteTarget, projectGroupingSettings, router],
  );
}

export function useNewThreadHandler() {
  const handleNewThread = useNewThreadState();

  return {
    handleNewThread,
  };
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useStore(
    useShallow((store) => selectWorkspaceProjectsAcrossEnvironments(store)),
  );
  const sidebarProjectSortOrder = useSettings((settings) => settings.sidebarProjectSortOrder);
  const sidebarThreads = useStore(
    useShallow((store) => selectSidebarThreadsAcrossEnvironments(store)),
  );
  const orderedProjects = useMemo(() => {
    const manuallyOrdered = orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
    });
    if (sidebarProjectSortOrder === "manual") {
      return manuallyOrdered;
    }
    // Mirror the sidebar's activity/created ordering so project pickers built
    // on this hook list projects in the same order the user sees there.
    return sortScopedProjectsByActivity(manuallyOrdered, sidebarThreads, sidebarProjectSortOrder);
  }, [projectOrder, projects, sidebarProjectSortOrder, sidebarThreads]);
  const handleNewThread = useNewThreadState();

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef: orderedProjects[0]
      ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)
      : null,
    handleNewThread,
    orderedProjects,
    routeThreadRef,
  };
}
