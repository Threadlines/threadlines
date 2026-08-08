import { scopedProjectKey } from "@threadlines/client-runtime";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  HostedStaticConnectionErrorState,
  HostedStaticLoadingState,
  HostedStaticOnboardingState,
  WorkspaceLoadingState,
} from "../components/ConnectionStatusStates";
import { NoActiveThreadState } from "../components/NoActiveThreadState";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import {
  selectBootstrapCompleteForActiveEnvironment,
  selectProjectsAcrossEnvironments,
  useStore,
} from "../store";
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

function DefaultProjectDraftRedirect() {
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();
  const defaultProjectKey = defaultProjectRef ? scopedProjectKey(defaultProjectRef) : null;
  const openDefaultProjectDraft = useEffectEvent(() => {
    if (defaultProjectRef) {
      void handleNewThread(defaultProjectRef, { replace: true });
    }
  });

  useEffect(() => {
    if (defaultProjectKey) {
      openDefaultProjectDraft();
    }
  }, [defaultProjectKey]);

  return defaultProjectRef === null ? <NoActiveThreadState /> : null;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
