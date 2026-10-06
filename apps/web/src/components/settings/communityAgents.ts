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

/**
 * What a failed community agent request says on screen: the server's own
 * sentence when it sent one (`AcpRegistryError`), else `fallback`. Anything
 * else is a transport error, whose text isn't written for a user.
 */
export function communityAgentErrorText(error: unknown, fallback: string): string {
  const isRegistryError =
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "AcpRegistryError";
  return isRegistryError && error instanceof Error && error.message.trim() !== ""
    ? error.message
    : fallback;
}
