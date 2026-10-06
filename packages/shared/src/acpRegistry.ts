/**
 * Rules for community agents (the ACP registry) that the server and the
 * clients must agree on.
 */
import { ProviderInstanceId } from "@threadlines/contracts";

/**
 * Registry agents Threadlines supports itself, as tested providers. They are
 * left out of the community list: the built-in one is the one to use.
 */
export const ACP_REGISTRY_BUILT_IN_AGENT_IDS: ReadonlySet<string> = new Set([
  "claude-acp",
  "codex-acp",
  "cursor",
  "opencode",
  "antigravity-acp",
]);

const INSTANCE_ID_PREFIX = "acp_";

/** A community agent's one instance. */
export const acpRegistryInstanceId = (agentId: string): ProviderInstanceId =>
  ProviderInstanceId.make(`${INSTANCE_ID_PREFIX}${agentId}`);
