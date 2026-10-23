/**
 * Small readers for community agents (agents from the ACP registry, driver
 * `acpRegistry`), shared by the settings surfaces that treat them apart.
 *
 * @module communityAgents
 */
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderCommunity,
} from "@threadlines/contracts";

import { useComputerProviders } from "../../environments/providerComputer";

/**
 * What the server says about a community agent, or undefined for any other
 * instance. `environmentId` names the computer that runs it; null is the
 * app's own backend.
 */
export function useCommunityAgent(
  instanceId: ProviderInstanceId | null,
  environmentId: EnvironmentId | null = null,
): ServerProviderCommunity | undefined {
  const providers = useComputerProviders(environmentId);
  return instanceId === null
    ? undefined
    : providers.find((provider) => provider.instanceId === instanceId)?.community;
}

/** Whether the instance is a community agent: one Threadlines runs but hasn't tested. */
export function useIsCommunityAgent(
  instanceId: ProviderInstanceId | null,
  environmentId: EnvironmentId | null = null,
): boolean {
  return useCommunityAgent(instanceId, environmentId) !== undefined;
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
