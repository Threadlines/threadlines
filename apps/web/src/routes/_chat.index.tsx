import { scopedProjectKey, scopeThreadRef } from "@threadlines/client-runtime";
import type { ThreadId } from "@threadlines/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";
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
import { isLaunchVisitConsumed, markLaunchVisitConsumed } from "../launchVisit";
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
 * What `/` resolves to once the workspace has loaded.
 *
 * The launch visit redirects into work: the last thread or draft this
 * environment had open when it still exists, else a fresh draft in the default
 * project (the long-standing cold-start behaviour). Every visit after that is
 * a navigation the user chose, and renders the home surface instead. The
 * restore record is checked against live state rather than trusted, so a
 * thread deleted elsewhere never strands the shell on a dead route.
 */
function DefaultProjectDraftRedirect() {
  const navigate = useNavigate();
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const defaultProjectKey = defaultProjectRef ? scopedProjectKey(defaultProjectRef) : null;
  // Captured at mount: a mount that begins after the launch moment passed --
  // it is marked the instant any thread or draft route renders, including via
  // the bootstrap welcome payload, which never touches this route -- is a
  // deliberate trip home and must never redirect.
  const [isLaunchVisit] = useState(() => !isLaunchVisitConsumed());

  const openLastVisitedOrDefaultDraft = useEffectEvent(() => {
    if (!isLaunchVisit || isLaunchVisitConsumed()) {
      return;
    }
    if (!activeEnvironmentId) {
      // Nothing to restore or redirect into yet; the effect re-runs once the
      // environment arrives, still counting as the launch visit.
      return;
    }
    markLaunchVisitConsumed();
    const entry = readLastVisitedThreadRoute(activeEnvironmentId);
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

  // The launch visit renders nothing while its redirect resolves (unless there
  // is no project to redirect into); a deliberate visit IS the home surface.
  return isLaunchVisit && defaultProjectRef !== null ? null : <NoActiveThreadState />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
