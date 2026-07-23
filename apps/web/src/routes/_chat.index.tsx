import { scopedProjectKey } from "@threadlines/client-runtime";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  HostedStaticConnectionErrorState,
  HostedStaticLoadingState,
  HostedStaticOnboardingState,
} from "../components/HostedStaticStatusStates";
import { NoActiveThreadState } from "../components/NoActiveThreadState";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { deriveHostedStaticIndexState } from "./-hostedStaticIndexState";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const savedEnvironments = useSavedEnvironmentRegistryStore(
    useShallow((state) => Object.values(state.byId)),
  );
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const environmentStateById = useStore((state) => state.environmentStateById);
  const projectCount = useStore((state) => selectProjectsAcrossEnvironments(state).length);

  if (authGateState.status === "hosted-static") {
    const hostedStaticState = deriveHostedStaticIndexState({
      savedEnvironments,
      savedEnvironmentRuntimeById,
      environmentStateById,
      projectCount,
    });

    switch (hostedStaticState.kind) {
      case "unpaired":
        return <HostedStaticOnboardingState />;
      case "loading":
        return <HostedStaticLoadingState label={hostedStaticState.label} />;
      case "connection-error":
        return (
          <HostedStaticConnectionErrorState
            label={hostedStaticState.label}
            message={hostedStaticState.message}
          />
        );
      case "ready":
        break;
    }
  }

  return <DefaultProjectDraftRedirect />;
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
