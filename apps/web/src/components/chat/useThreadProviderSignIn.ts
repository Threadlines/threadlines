import type { EnvironmentId, ProviderInstanceId } from "@threadlines/contracts";
import { useMemo } from "react";

import { isAppBackendEnvironment, useComputerProviders } from "../../environments/providerComputer";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { useProviderConnectFlow } from "../settings/useProviderConnectFlow";
import { useComputerLabel } from "../sidebar/linkedComputers";
import {
  type ProviderSignInElsewhere,
  type ProviderSignInFlowView,
  toProviderSignInFlowView,
} from "./providerSignIn";

/**
 * The composer's sign-in for the agent a thread sends to. It runs on the
 * computer the thread runs on (`environmentId`; null is the app's own
 * backend), and a computer the app's Settings doesn't show finishes in the
 * sign-in window, named for that computer and agent.
 */
export function useThreadProviderSignIn(input: {
  readonly instanceId: ProviderInstanceId | null;
  readonly environmentId: EnvironmentId | null;
  /** What to call the agent when its computer hasn't named it. */
  readonly providerLabel: string;
  /** Fired once per run that ends in `succeeded`. */
  readonly onSucceeded?: (() => void) | undefined;
}): ProviderSignInFlowView {
  const { instanceId, environmentId, providerLabel, onSucceeded } = input;
  const controller = useProviderConnectFlow({
    instanceId,
    environmentId,
    flow: "login",
    onSucceeded,
  });
  const providers = useComputerProviders(environmentId);
  const resolveComputerLabel = useComputerLabel();
  // Read each render: on a phone the backend is whichever computer it's on.
  const onBackend = environmentId === null || isAppBackendEnvironment(environmentId);
  const elsewhere = useMemo<ProviderSignInElsewhere | null>(() => {
    if (instanceId === null || environmentId === null || onBackend) {
      return null;
    }
    const provider = providers.find((status) => status.instanceId === instanceId);
    return {
      environmentId,
      displayName:
        provider?.displayName?.trim() ||
        (provider ? formatProviderDriverKindLabel(provider.driver) : providerLabel),
      computerLabel: resolveComputerLabel(environmentId, "") || null,
      driver: provider?.driver ?? null,
    };
  }, [environmentId, instanceId, onBackend, providerLabel, providers, resolveComputerLabel]);
  return useMemo(
    () => toProviderSignInFlowView({ instanceId, controller, elsewhere }),
    [controller, elsewhere, instanceId],
  );
}
