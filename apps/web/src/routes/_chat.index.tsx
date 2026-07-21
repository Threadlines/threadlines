import { createFileRoute } from "@tanstack/react-router";
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

  return <NoActiveThreadState />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
