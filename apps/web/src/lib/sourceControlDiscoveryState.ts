import { useAtomValue } from "@effect/atom-react";
import {
  type SourceControlDiscoveryTarget,
  type SourceControlDiscoveryState,
  createSourceControlDiscoveryManager,
  getSourceControlDiscoveryTargetKey,
  sourceControlDiscoveryStateAtom,
  createSourceControlSetupManager,
  sourceControlSetupStateAtom,
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
import { useEffect } from "react";

import { readPrimaryEnvironmentDescriptor } from "../environments/primary";
import { readEnvironmentConnection } from "../environments/runtime";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";

const SOURCE_CONTROL_DISCOVERY_TARGET = { key: "primary" } as const;
const SOURCE_CONTROL_DISCOVERY_STALE_TIME_MS = 30_000;
const SOURCE_CONTROL_DISCOVERY_IDLE_TTL_MS = 5 * 60_000;

interface SourceControlDiscoveryTargetInput {
  readonly environmentId?: EnvironmentId | null | undefined;
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

export const sourceControlSetupManager = createSourceControlSetupManager({
  getRegistry: () => appAtomRegistry,
  getClient: (key) =>
    readSourceControlServer(
      key === SOURCE_CONTROL_DISCOVERY_TARGET.key
        ? undefined
        : { environmentId: EnvironmentId.make(key) },
    ),
  onSettled: (key) => {
    void sourceControlDiscoveryManager.refresh({ key }, undefined, { force: true });
  },
});

export function useSourceControlSetup(input?: SourceControlDiscoveryTargetInput) {
  const key = sourceControlDiscoveryTarget(input).key ?? SOURCE_CONTROL_DISCOVERY_TARGET.key;
  useEffect(() => sourceControlSetupManager.watch(key), [key]);
  return useAtomValue(sourceControlSetupStateAtom(key));
}

export async function startGitHubSignIn(input?: SourceControlDiscoveryTargetInput): Promise<void> {
  const server = readSourceControlServer(input);
  if (!server) throw new Error("This environment is not connected.");
  const key = sourceControlDiscoveryTarget(input).key ?? SOURCE_CONTROL_DISCOVERY_TARGET.key;
  const githubAuth = await server.startGitHubAuth();
  const current = appAtomRegistry.get(sourceControlSetupStateAtom(key));
  sourceControlSetupManager.store(key, { ...current, githubAuth });
  void sourceControlSetupManager.refresh(key);
}

export async function cancelGitHubSignIn(input?: SourceControlDiscoveryTargetInput): Promise<void> {
  const server = readSourceControlServer(input);
  if (!server) throw new Error("This environment is not connected.");
  await server.cancelGitHubAuth();
  const key = sourceControlDiscoveryTarget(input).key ?? SOURCE_CONTROL_DISCOVERY_TARGET.key;
  const current = appAtomRegistry.get(sourceControlSetupStateAtom(key));
  sourceControlSetupManager.store(key, {
    ...current,
    githubAuth: { status: "cancelled", verificationUrl: null, userCode: null, message: null },
  });
  await sourceControlSetupManager.refresh(
    sourceControlDiscoveryTarget(input).key ?? SOURCE_CONTROL_DISCOVERY_TARGET.key,
  );
}

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

  const target = sourceControlDiscoveryTarget(input);
  sourceControlSetupManager.markToolPending(
    target.key ?? SOURCE_CONTROL_DISCOVERY_TARGET.key,
    input,
  );
  try {
    const result = await server.updateSourceControlTool({
      target: input.target,
      ...(input.operation ? { operation: input.operation } : {}),
    });
    sourceControlDiscoveryManager.storeResult(
      sourceControlDiscoveryTarget(input),
      result.discovery,
    );
    return result;
  } finally {
    void sourceControlSetupManager.refresh(target.key ?? SOURCE_CONTROL_DISCOVERY_TARGET.key);
  }
}

export function getSourceControlDiscoverySnapshot(
  input?: SourceControlDiscoveryTargetInput,
): SourceControlDiscoveryState {
  return sourceControlDiscoveryManager.getSnapshot(sourceControlDiscoveryTarget(input));
}

export function resetSourceControlDiscoveryStateForTests(): void {
  sourceControlDiscoveryManager.reset();
  sourceControlSetupManager.reset();
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
