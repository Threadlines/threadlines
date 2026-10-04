/**
 * The setup screen's rules: which agents start picked, when Connect is
 * skipped, when each step may continue, and what Continue writes.
 *
 * Setup manages the six built-in agents' default instances only; custom
 * instances are Settings' business. Everything here is derived from the same
 * `deriveAgentStatus` the Providers page uses, so the two never disagree about
 * whether an agent is ready.
 *
 * @module agentSetup.logic
 */
import type { ProviderDriverKind, ServerProvider } from "@threadlines/contracts";
import { defaultInstanceIdForDriver } from "@threadlines/contracts";

import { deriveAgentStatus, isAgentReady, type AgentStatus } from "../settings/agentStatus";
import type { ProviderEnablementChange } from "../settings/providerEnablement";
import { DRIVER_OPTIONS, type ProviderClientDefinition } from "../settings/providerDriverMeta";
import type { ProviderSettingsRow } from "../settings/SettingsPanels.logic";

export type SetupStep = "agents" | "connect" | "folder";

const SETUP_STEPS: ReadonlyArray<SetupStep> = ["agents", "connect", "folder"];

export function parseSetupStep(value: unknown): SetupStep | null {
  return typeof value === "string" && (SETUP_STEPS as ReadonlyArray<string>).includes(value)
    ? (value as SetupStep)
    : null;
}

export interface SetupAgent {
  readonly driverKind: ProviderDriverKind;
  readonly definition: ProviderClientDefinition;
  /** The driver's default instance, as Settings lists it. */
  readonly row: ProviderSettingsRow;
  readonly snapshot: ServerProvider | undefined;
  readonly status: AgentStatus;
}

/** The six built-in agents, in the order Settings lists them. */
export function deriveSetupAgents(input: {
  readonly rows: ReadonlyArray<ProviderSettingsRow>;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ReadonlyArray<SetupAgent> {
  return DRIVER_OPTIONS.flatMap((definition) => {
    const instanceId = defaultInstanceIdForDriver(definition.value);
    const row = input.rows.find((candidate) => candidate.instanceId === instanceId);
    if (!row) return [];
    const snapshot = input.providers.find((provider) => provider.instanceId === instanceId);
    return [
      {
        driverKind: definition.value,
        definition,
        row,
        snapshot,
        status: deriveAgentStatus({
          enabled: row.instance.enabled ?? true,
          driverKind: definition.value,
          snapshot,
        }),
      },
    ];
  });
}

/**
 * The agents that start picked: everything on this computer. Turned-on agents
 * count when the full check found them installed (signed in or not);
 * turned-off ones when the file-only look found them.
 *
 * Returns null while a turned-on agent is still being checked, because a
 * provisional snapshot cannot say whether it is installed. `force` (after a
 * bounded wait) counts those as picked: they are already on.
 */
export function deriveInitialPicks(
  agents: ReadonlyArray<SetupAgent>,
  options: { readonly force?: boolean } = {},
): ReadonlySet<ProviderDriverKind> | null {
  if (!options.force && agents.some((agent) => agent.status.kind === "checking")) {
    return null;
  }
  return new Set(
    agents
      .filter((agent) => {
        switch (agent.status.kind) {
          case "off":
            return agent.status.detection?.status === "found";
          case "notInstalled":
            return false;
          default:
            return true;
        }
      })
      .map((agent) => agent.driverKind),
  );
}

function pickedAgents(
  agents: ReadonlyArray<SetupAgent>,
  picks: ReadonlySet<ProviderDriverKind>,
): ReadonlyArray<SetupAgent> {
  return agents.filter((agent) => picks.has(agent.driverKind));
}

/**
 * Where Continue on the Agents step goes. Connect is skipped when everything
 * picked already works, judged at the moment of the click.
 */
export function stepAfterAgents(
  agents: ReadonlyArray<SetupAgent>,
  picks: ReadonlySet<ProviderDriverKind>,
): "connect" | "folder" {
  const picked = pickedAgents(agents, picks);
  return picked.length > 0 && picked.every((agent) => isAgentReady(agent.status))
    ? "folder"
    : "connect";
}

export function countReadyPicks(
  agents: ReadonlyArray<SetupAgent>,
  picks: ReadonlySet<ProviderDriverKind>,
): number {
  return pickedAgents(agents, picks).filter((agent) => isAgentReady(agent.status)).length;
}

/**
 * The on/off writes Continue makes: picked agents on, the rest off. Agents
 * already in the right state produce no write.
 */
export function setupEnablementChanges(
  agents: ReadonlyArray<SetupAgent>,
  picks: ReadonlySet<ProviderDriverKind>,
): ReadonlyArray<ProviderEnablementChange> {
  return agents.map((agent) => ({ row: agent.row, enabled: picks.has(agent.driverKind) }));
}

/** The first sentence on the Agents step, naming what the scan found. */
export function describeFoundAgents(input: {
  readonly found: ReadonlyArray<string>;
  readonly computer: string;
}): string {
  const { found, computer } = input;
  if (found.length === 0) {
    return `We didn't find any agents on ${computer}. Pick the ones you want and we'll install them.`;
  }
  const names =
    found.length === 1
      ? found[0]!
      : `${found.slice(0, -1).join(", ")} and ${found[found.length - 1]!}`;
  return `Pick as many as you like. We found ${names} on ${computer} and picked ${
    found.length === 1 ? "it" : "them"
  } for you.`;
}
