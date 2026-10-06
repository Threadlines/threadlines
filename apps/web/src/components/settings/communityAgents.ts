/**
 * Small readers for community agents (agents from the ACP registry, driver
 * `acpRegistry`), shared by the settings surfaces that treat them apart.
 *
 * @module communityAgents
 */
import type { ProviderInstanceId, ServerProviderCommunity } from "@threadlines/contracts";

import { useServerProviders } from "../../rpc/serverState";

/** What the server says about a community agent, or undefined for any other instance. */
export function useCommunityAgent(
  instanceId: ProviderInstanceId | null,
): ServerProviderCommunity | undefined {
  const providers = useServerProviders();
  return instanceId === null
    ? undefined
    : providers.find((provider) => provider.instanceId === instanceId)?.community;
}

/** Whether the instance is a community agent: one Threadlines runs but hasn't tested. */
export function useIsCommunityAgent(instanceId: ProviderInstanceId | null): boolean {
  return useCommunityAgent(instanceId) !== undefined;
}
