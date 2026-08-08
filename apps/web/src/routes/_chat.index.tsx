import { scopedProjectKey, scopeThreadRef } from "@threadlines/client-runtime";
import type { ThreadId } from "@threadlines/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  HostedStaticConnectionErrorState,
  HostedStaticLoadingState,
  HostedStaticOnboardingState,
  WorkspaceLoadingState,
} from "../components/ConnectionStatusStates";
import { NoActiveThreadState } from "../components/NoActiveThreadState";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import {
  readLastVisitedThreadRoute,
  resolveRestorableThreadRoute,
} from "../lastVisitedThreadRoute";
import {
  selectBootstrapCompleteForActiveEnvironment,
  selectProjectsAcrossEnvironments,
  selectThreadExistsByRef,
  useStore,
} from "../store";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { deriveChatIndexState } from "./-chatIndexState";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const savedEnvironments = useSavedEnvironmentRegistryStore(
    useShallow((state) => Object.values(state.byId)),
  );
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const environmentStateById = useStore((state) => state.environmentStateById);
  const projectCount = useStore((state) => selectProjectsAcrossEnvironments(state).length);
  const bootstrapComplete = useStore(selectBootstrapCompleteForActiveEnvironment);

  const indexState = deriveChatIndexState({
    hostedStatic: authGateState.status === "hosted-static",
    bootstrapComplete,
    savedEnvironments,
    savedEnvironmentRuntimeById,
    environmentStateById,
    projectCount,
  });

  switch (indexState.kind) {
    case "unpaired":
      return <HostedStaticOnboardingState />;
    case "loading":
      return <HostedStaticLoadingState label={indexState.label} />;
    case "workspace-loading":
      return <WorkspaceLoadingState />;
    case "connection-error":
      return (
        <HostedStaticConnectionErrorState label={indexState.label} message={indexState.message} />
      );
    case "ready":
      return <DefaultProjectDraftRedirect />;
  }
}

/**
 * Restoring is something a launch does, not a rule about `/`. Later trips home
 * are deliberate ("Go to Home", the settings back button with no history left)
 * and must land on the home surface instead of being bounced straight back, so
 * the record is consulted once per app load.
 */
let restoreAttempted = false;

/**
 * What `/` resolves to once the workspace has loaded.
 *
 * A relaunch lands here with no route to speak of, so the last thread this
 * environment had open wins when it still exists -- otherwise this falls back
 * to the long-standing behaviour of opening a draft in the default project.
 * The record is checked against live state rather than trusted, so a thread
 * deleted elsewhere never strands the shell on a dead route.
 */
function DefaultProjectDraftRedirect() {
  const navigate = useNavigate();
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const defaultProjectKey = defaultProjectRef ? scopedProjectKey(defaultProjectRef) : null;

  const openLastVisitedOrDefaultDraft = useEffectEvent(() => {
    const entry = restoreAttempted ? null : readLastVisitedThreadRoute(activeEnvironmentId);
    if (activeEnvironmentId) {
      // Only counts as the load-time attempt once there is an environment to
      // read a record from; before that there was nothing to restore.
      restoreAttempted = true;
    }
    const restored = resolveRestorableThreadRoute({
      entry,
      environmentId: activeEnvironmentId,
      serverThreadExists:
        entry?.kind === "server" && activeEnvironmentId
          ? selectThreadExistsByRef(
              useStore.getState(),
              scopeThreadRef(activeEnvironmentId, entry.threadId as ThreadId),
            )
          : false,
      draftThreadExists:
        entry?.kind === "draft"
          ? useComposerDraftStore.getState().getDraftSession(entry.draftId as DraftId) !== null
          : false,
    });

    if (restored?.kind === "server") {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(restored.threadRef),
        replace: true,
      });
      return;
    }
    if (restored?.kind === "draft") {
      void navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(restored.draftId),
        replace: true,
      });
      return;
    }
    if (defaultProjectRef) {
      void handleNewThread(defaultProjectRef, { replace: true });
    }
  });

  useEffect(() => {
    openLastVisitedOrDefaultDraft();
  }, [activeEnvironmentId, defaultProjectKey]);

  return defaultProjectRef === null ? <NoActiveThreadState /> : null;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
