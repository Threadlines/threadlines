import { useAtomValue } from "@effect/atom-react";
import {
  type SourceControlDiscoveryTarget,
  type SourceControlDiscoveryState,
  createSourceControlDiscoveryManager,
  getSourceControlDiscoveryTargetKey,
  sourceControlDiscoveryStateAtom,
} from "@threadlines/client-runtime";
import {
  EnvironmentId,
  type LocalApi,
  type SourceControlDiscoveryResult,
  type SourceControlToolUpdateInput,
  type SourceControlToolUpdateResult,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import { readPrimaryEnvironmentDescriptor } from "../environments/primary";
import { readEnvironmentConnection } from "../environments/runtime";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";

const SOURCE_CONTROL_DISCOVERY_TARGET = { key: "primary" } as const;
const SOURCE_CONTROL_DISCOVERY_STALE_TIME_MS = 30_000;
const SOURCE_CONTROL_DISCOVERY_IDLE_TTL_MS = 5 * 60_000;

interface SourceControlDiscoveryTargetInput {
  readonly environmentId?: EnvironmentId | null;
}

function readSourceControlServer(
  input?: SourceControlDiscoveryTargetInput,
): LocalApi["server"] | null {
  const target = sourceControlDiscoveryTarget(input);
  if (target.key === SOURCE_CONTROL_DISCOVERY_TARGET.key) {
    const primaryEnvironmentId = readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
    const primaryConnection = primaryEnvironmentId
      ? readEnvironmentConnection(primaryEnvironmentId)
      : null;
    if (primaryConnection) return primaryConnection.client.server;
    try {
      return readLocalApi()?.server ?? null;
    } catch {
      return null;
    }
  }

  return target.key
    ? (readEnvironmentConnection(EnvironmentId.make(target.key))?.client.server ?? null)
    : null;
}

function sourceControlDiscoveryTarget(
  input?: SourceControlDiscoveryTargetInput,
): SourceControlDiscoveryTarget {
  const environmentId = input?.environmentId ?? null;
  if (!environmentId) {
    return SOURCE_CONTROL_DISCOVERY_TARGET;
  }
  return readPrimaryEnvironmentDescriptor()?.environmentId === environmentId
    ? SOURCE_CONTROL_DISCOVERY_TARGET
    : { key: environmentId };
}

export const sourceControlDiscoveryManager = createSourceControlDiscoveryManager({
  getRegistry: () => appAtomRegistry,
  getClient: (key) =>
    readSourceControlServer(
      key === SOURCE_CONTROL_DISCOVERY_TARGET.key
        ? undefined
        : { environmentId: EnvironmentId.make(key) },
    ),
});

const sourceControlDiscoveryAutoRefreshAtom = Atom.family((targetKey: string) =>
  Atom.make(() =>
    Effect.promise(() => sourceControlDiscoveryManager.refresh({ key: targetKey })),
  ).pipe(
    Atom.swr({
      staleTime: SOURCE_CONTROL_DISCOVERY_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(SOURCE_CONTROL_DISCOVERY_IDLE_TTL_MS),
    Atom.withLabel(`source-control-discovery:auto-refresh:${targetKey}`),
  ),
);

export function refreshSourceControlDiscovery(
  input?: SourceControlDiscoveryTargetInput,
): Promise<SourceControlDiscoveryResult | null> {
  return sourceControlDiscoveryManager.refresh(sourceControlDiscoveryTarget(input));
}

export function refreshSourceControlDiscoveryAfterReconnect(
  input?: SourceControlDiscoveryTargetInput,
): Promise<SourceControlDiscoveryResult | null> {
  return sourceControlDiscoveryManager.refresh(sourceControlDiscoveryTarget(input), undefined, {
    force: true,
  });
}

export async function updateSourceControlTool(
  input: SourceControlDiscoveryTargetInput & SourceControlToolUpdateInput,
): Promise<SourceControlToolUpdateResult> {
  const server = readSourceControlServer(input);
  if (!server) {
    throw new Error("The selected server environment is not connected.");
  }

  const result = await server.updateSourceControlTool({
    target: input.target,
    ...(input.operation ? { operation: input.operation } : {}),
  });
  sourceControlDiscoveryManager.storeResult(sourceControlDiscoveryTarget(input), result.discovery);
  return result;
}

export function getSourceControlDiscoverySnapshot(
  input?: SourceControlDiscoveryTargetInput,
): SourceControlDiscoveryState {
  return sourceControlDiscoveryManager.getSnapshot(sourceControlDiscoveryTarget(input));
}

export function resetSourceControlDiscoveryStateForTests(): void {
  sourceControlDiscoveryManager.reset();
}

export function useSourceControlDiscovery(
  input?: SourceControlDiscoveryTargetInput,
): SourceControlDiscoveryState {
  const targetKey =
    getSourceControlDiscoveryTargetKey(sourceControlDiscoveryTarget(input)) ??
    SOURCE_CONTROL_DISCOVERY_TARGET.key;

  useAtomValue(sourceControlDiscoveryAutoRefreshAtom(targetKey));

  return useAtomValue(sourceControlDiscoveryStateAtom(targetKey));
}
