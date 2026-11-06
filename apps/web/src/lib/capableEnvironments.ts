/**
 * The computers this app can reach whose servers report a capability: this
 * computer first, then every connected saved computer by name. An absent
 * capability (an older Threadlines) is a no. Scheduled tasks and the theme
 * library list their computers through it.
 */
import type {
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
  ExecutionEnvironmentDescriptor,
} from "@threadlines/contracts";

import type { SavedEnvironmentConnectionState } from "../environments/runtime/catalog";
import { resolveEnvironmentOptionLabel } from "../components/BranchToolbar.logic";

export interface CapableComputer {
  readonly connectionState: SavedEnvironmentConnectionState;
  readonly descriptor: Pick<ExecutionEnvironmentDescriptor, "capabilities" | "label"> | null;
}

export interface CapableEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly capabilities: ExecutionEnvironmentCapabilities;
}

type BooleanCapability = {
  [K in keyof ExecutionEnvironmentCapabilities]-?: NonNullable<
    ExecutionEnvironmentCapabilities[K]
  > extends boolean
    ? K
    : never;
}[keyof ExecutionEnvironmentCapabilities];

export function capableEnvironmentsOf(
  capability: BooleanCapability,
  input: {
    readonly primaryEnvironmentId: EnvironmentId | null;
    readonly primaryDescriptor: Pick<
      ExecutionEnvironmentDescriptor,
      "capabilities" | "label"
    > | null;
    readonly runtimeById: Readonly<Record<EnvironmentId, CapableComputer>>;
    readonly savedLabelOf: (environmentId: EnvironmentId) => string | null;
  },
): CapableEnvironment[] {
  const seen = new Set<EnvironmentId>();
  const first: CapableEnvironment[] = [];
  const { primaryEnvironmentId, primaryDescriptor } = input;
  if (primaryEnvironmentId && primaryDescriptor?.capabilities[capability] === true) {
    seen.add(primaryEnvironmentId);
    first.push({
      environmentId: primaryEnvironmentId,
      isPrimary: true,
      capabilities: primaryDescriptor.capabilities,
      label: resolveEnvironmentOptionLabel({
        isPrimary: true,
        environmentId: primaryEnvironmentId,
        runtimeLabel: primaryDescriptor.label,
      }),
    });
  }
  const others: CapableEnvironment[] = [];
  for (const environmentId of Object.keys(input.runtimeById) as EnvironmentId[]) {
    if (seen.has(environmentId)) continue;
    const runtime = input.runtimeById[environmentId];
    if (!runtime || runtime.connectionState !== "connected") continue;
    if (runtime.descriptor?.capabilities[capability] !== true) continue;
    seen.add(environmentId);
    others.push({
      environmentId,
      isPrimary: false,
      capabilities: runtime.descriptor.capabilities,
      label: resolveEnvironmentOptionLabel({
        isPrimary: false,
        environmentId,
        runtimeLabel: runtime.descriptor.label,
        savedLabel: input.savedLabelOf(environmentId),
      }),
    });
  }
  return [...first, ...others.toSorted((a, b) => a.label.localeCompare(b.label))];
}
