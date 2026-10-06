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

/**
 * Whether an instance id is a community agent's. For an instance that is
 * gone: one that is still there says so itself (driver `acpRegistry`).
 */
export const isAcpRegistryInstanceId = (instanceId: string): boolean =>
  instanceId.startsWith(INSTANCE_ID_PREFIX);

/** What the wording below reads from a listed or installed agent. */
export interface AcpRegistryAgentWording {
  readonly name: string;
  readonly authors: ReadonlyArray<string>;
  readonly source: "npm" | "download";
  readonly packageSpec: string | null;
  readonly host: string | null;
  readonly integrity: "checksum" | "none" | "package";
}

const joinNames = (names: ReadonlyArray<string>): string => {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

/**
 * An author as a sentence names them. The registry sometimes writes
 * "Name <address>": the name alone. An address with no name stays.
 */
const authorName = (author: string): string =>
  author.replace(/\s*<[^<>]*>\s*$/u, "").trim() || author.trim();

/** "Block", "Block and Square", or "" when the registry names nobody. */
export const acpRegistryAuthorLine = (authors: ReadonlyArray<string>): string =>
  joinNames(authors.map(authorName).filter((author) => author.length > 0));

/**
 * What the user agrees to before an agent is installed. `computer` is where
 * it will run, as this client would say it: "this Mac", or the paired
 * computer's name when the client is a phone.
 */
export function acpRegistryInstallConfirmText(input: {
  readonly agent: Pick<AcpRegistryAgentWording, "name" | "authors">;
  readonly computer: string;
}): string {
  const authors = acpRegistryAuthorLine(input.agent.authors);
  const origin = authors
    ? `${input.agent.name} is made by ${authors}.`
    : `${input.agent.name} comes from the open ACP registry.`;
  return `${origin} Threadlines hasn't reviewed it. It runs on ${input.computer} and can read and change files in your projects.`;
}

/** Where an agent's files come from, and whether the download can be checked. */
export function acpRegistrySourceText(
  agent: Pick<AcpRegistryAgentWording, "source" | "packageSpec" | "host" | "integrity">,
): string {
  if (agent.source === "npm") {
    return agent.packageSpec ? `Installs ${agent.packageSpec} from npm.` : "Installs from npm.";
  }
  const from = agent.host ? `Downloads from ${agent.host}.` : "Downloads from its publisher.";
  return agent.integrity === "checksum"
    ? `${from} The download is checked against the publisher's checksum.`
    : `${from} The publisher gives no checksum.`;
}

/** "by Block · A local, extensible AI agent", or either half alone. */
export function acpRegistryRowSubtitle(agent: {
  readonly authors: ReadonlyArray<string>;
  readonly description: string;
}): string {
  const authors = acpRegistryAuthorLine(agent.authors);
  return [authors ? `by ${authors}` : "", agent.description.trim()]
    .filter((part) => part.length > 0)
    .join(" · ");
}

/** The agents that match a search, on name, id, author and description. Empty query: all. */
export function filterAcpRegistryAgents<
  Agent extends {
    readonly agentId: string;
    readonly name: string;
    readonly authors: ReadonlyArray<string>;
    readonly description: string;
  },
>(agents: ReadonlyArray<Agent>, query: string): ReadonlyArray<Agent> {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return agents;
  return agents.filter((agent) => {
    const text = [agent.name, agent.agentId, ...agent.authors, agent.description]
      .join("\n")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** Ids of agents whose name another listed agent shares: their rows show the id too. */
export function acpRegistryAmbiguousAgentIds(
  agents: ReadonlyArray<{ readonly agentId: string; readonly name: string }>,
): ReadonlySet<string> {
  const byName = new Map<string, Array<string>>();
  for (const agent of agents) {
    const key = agent.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), agent.agentId]);
  }
  return new Set([...byName.values()].filter((ids) => ids.length > 1).flat());
}
