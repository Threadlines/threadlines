import { scopedProjectKey, scopeProjectRef } from "@threadlines/client-runtime";
import {
  DEFAULT_NEW_THREAD_RUNTIME_MODE,
  type ScopedProjectRef,
  type ThreadEnvMode,
  type ThreadId,
} from "@threadlines/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@threadlines/contracts/settings";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  composerDraftHasUserContent,
  type DraftId,
  type DraftThreadEnvMode,
  type DraftThreadState,
  isKnownMissingCheckout,
  useComposerDraftStore,
} from "../composerDraftStore";
import { preserveRightPanelSearchParamsForDraftNavigation } from "../diffRouteSearch";
import { resolveNewThreadPlacement } from "../lib/chatThreadActions";
import { newDraftId, newThreadId } from "../lib/utils";
import {
  applyNewThreadDefaultsToDraft,
  placeDraftFromSettings,
  readComputerConfig,
} from "../newThreadDefaults";
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
  selectThreadByRef,
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
        /** Where the thread starts. Leave `branch`, `worktreePath` and
         *  `envMode` all out and it starts where the computer's "Start in"
         *  setting says (`resolveNewThreadPlacement`); pass any to pin it. */
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
        /** False starts from the setting alone. By default a thread started
         *  from one in the same project can continue in its checkout. */
        continueActiveCheckout?: boolean;
        replace?: boolean;
        /** Words the draft opens with, for surfaces that hand work over. Only
         *  ever written into a draft with nothing of the user's in it. */
        initialPrompt?: string;
        /** The thread the draft must become, for a caller that already named it
         *  to the server (the checkout dialog starts the worktree's setup script
         *  under it). Always mints a fresh draft, since a reused one has its own. */
        threadId?: ThreadId;
      },
    ): Promise<void> => {
      const {
        adoptDraftSessionForLogicalProjectKey,
        getComposerDraft,
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
        setLogicalProjectDraftThreadId,
        setPrompt,
      } = useComposerDraftStore.getState();
      const initialPrompt = options?.initialPrompt?.trim() ?? "";
      const writeInitialPrompt = (draftId: DraftId) => {
        if (initialPrompt.length > 0) {
          setPrompt(draftId, initialPrompt);
        }
      };
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
      const requiredThreadId = options?.threadId ?? null;
      const storedDraftThread = requiredThreadId
        ? null
        : (getDraftSessionByLogicalProjectKey(logicalProjectKey) ??
          adoptDraftSessionForLogicalProjectKey(projectRef, logicalProjectKey));
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
      // A caller that names where the thread starts is taken at its word.
      // Every other new thread starts where its computer's "Start in" says,
      // read here so no surface can leave the setting out.
      const isPlacementPinned = hasBranchOption || hasWorktreePathOption || hasEnvModeOption;
      const computerSettings = isPlacementPinned
        ? null
        : (readComputerConfig(projectRef.environmentId)?.settings ?? null);
      const activeThread =
        currentRouteTarget?.kind === "server"
          ? selectThreadByRef(useStore.getState(), currentRouteTarget.threadRef)
          : undefined;
      const placementFor = (startIn: ThreadEnvMode) =>
        resolveNewThreadPlacement({
          projectRef,
          startIn,
          isGeneralChat: project?.kind === "general-chat",
          continueActiveCheckout: options?.continueActiveCheckout ?? true,
          activeThread,
          activeDraftThread: latestActiveDraftThread,
          isCheckoutMissing: (cwd) =>
            isKnownMissingCheckout({ environmentId: projectRef.environmentId, cwd }),
        });
      const placement = isPlacementPinned
        ? {
            ...(options?.branch !== undefined ? { branch: options.branch } : {}),
            ...(options?.worktreePath !== undefined ? { worktreePath: options.worktreePath } : {}),
            ...(options?.envMode !== undefined ? { envMode: options.envMode } : {}),
          }
        : placementFor(
            computerSettings?.defaultThreadEnvMode ?? DEFAULT_SERVER_SETTINGS.defaultThreadEnvMode,
          );
      // A draft can open before its computer's settings arrive (the first new
      // thread at startup). It opens on the built-in default and takes its
      // place when they come, unless the user has placed it by then.
      const placeFromSettings = (draftId: DraftId) =>
        placeDraftFromSettings(
          draftId,
          projectRef.environmentId,
          isPlacementPinned || computerSettings !== null ? null : placementFor,
        );
      if (emptyStoredDraftThread) {
        return (async () => {
          // The place goes in with the move: a draft reused from the same
          // project on another computer would otherwise land on that
          // computer's project root whatever was asked.
          setLogicalProjectDraftThreadId(
            logicalProjectKey,
            projectRef,
            emptyStoredDraftThread.draftId,
            {
              threadId: emptyStoredDraftThread.threadId,
              ...placement,
            },
          );
          placeFromSettings(emptyStoredDraftThread.draftId);
          writeInitialPrompt(emptyStoredDraftThread.draftId);
          // A reused draft can hold the model and agents it was set up with
          // long ago; "new thread" means today's, so the defaults are applied
          // again, after the draft is on its project (moving it drops a room).
          // The draft opens meanwhile: the defaults never hold it up.
          const defaultsApplied = applyNewThreadDefaultsToDraft(
            emptyStoredDraftThread.draftId,
            projectRef.environmentId,
          );
          if (
            currentRouteTarget?.kind !== "draft" ||
            currentRouteTarget.draftId !== emptyStoredDraftThread.draftId
          ) {
            await router.navigate({
              to: "/draft/$draftId",
              params: { draftId: emptyStoredDraftThread.draftId },
              search: preserveRightPanelSearchParamsForDraftNavigation,
              replace: options?.replace ?? false,
            });
          }
          await defaultsApplied;
        })();
      }

      if (
        !requiredThreadId &&
        latestActiveDraftThread &&
        currentRouteTarget?.kind === "draft" &&
        latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
        latestActiveDraftThread.promotedTo == null &&
        // Same content rule as above: a new-thread request while viewing an
        // invested draft mints a fresh one instead of repurposing it.
        !composerDraftHasUserContent(getComposerDraft(currentRouteTarget.draftId))
      ) {
        const currentDraftId = currentRouteTarget.draftId;
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentDraftId, {
          threadId: latestActiveDraftThread.threadId,
          createdAt: latestActiveDraftThread.createdAt,
          runtimeMode: latestActiveDraftThread.runtimeMode,
          interactionMode: latestActiveDraftThread.interactionMode,
          ...placement,
        });
        placeFromSettings(currentDraftId);
        writeInitialPrompt(currentDraftId);
        return applyNewThreadDefaultsToDraft(currentDraftId, projectRef.environmentId);
      }

      const draftId = newDraftId();
      const threadId = requiredThreadId ?? newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
          threadId,
          createdAt,
          branch: null,
          worktreePath: null,
          envMode: "local",
          ...placement,
          runtimeMode: DEFAULT_NEW_THREAD_RUNTIME_MODE,
        });
        placeFromSettings(draftId);
        writeInitialPrompt(draftId);
        const defaultsApplied = applyNewThreadDefaultsToDraft(draftId, projectRef.environmentId);

        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
          search: preserveRightPanelSearchParamsForDraftNavigation,
          replace: options?.replace ?? false,
        });
        await defaultsApplied;
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
