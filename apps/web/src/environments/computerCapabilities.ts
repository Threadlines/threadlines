/**
 * Whether a computer this app knows can do something now: connected to this
 * app, and its server reporting the capability (older servers leave theirs
 * out). The app's own computer is connected as long as the app is running.
 */
import type {
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
  ExecutionEnvironmentDescriptor,
} from "@threadlines/contracts";

import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentDescriptor } from "./primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
  type SavedEnvironmentRuntimeState,
} from "./runtime";

/** Every computer this app knows, its own first. */
export function knownComputerIds(): EnvironmentId[] {
  const primary = readPrimaryEnvironmentDescriptor()?.environmentId;
  const saved = Object.keys(useSavedEnvironmentRegistryStore.getState().byId) as EnvironmentId[];
  return primary === undefined ? saved : [primary, ...saved.filter((id) => id !== primary)];
}

export function readConnectedComputerCapability(
  environmentId: EnvironmentId,
  capability: keyof ExecutionEnvironmentCapabilities,
): boolean {
  return capabilityOf(
    environmentId,
    capability,
    readPrimaryEnvironmentDescriptor(),
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId],
  );
}

/**
 * {@link readConnectedComputerCapability}, kept current for a component: a
 * surface that renders before the computer's server has said what it can do
 * (right after the app starts, or while it reconnects) redraws once it has.
 */
export function useConnectedComputerCapability(
  environmentId: EnvironmentId | null,
  capability: keyof ExecutionEnvironmentCapabilities,
): boolean {
  const primary = usePrimaryEnvironmentDescriptor();
  const runtime = useSavedEnvironmentRuntimeStore((state) =>
    environmentId === null ? undefined : state.byId[environmentId],
  );
  return environmentId !== null && capabilityOf(environmentId, capability, primary, runtime);
}

function capabilityOf(
  environmentId: EnvironmentId,
  capability: keyof ExecutionEnvironmentCapabilities,
  primary: ExecutionEnvironmentDescriptor | null,
  runtime: SavedEnvironmentRuntimeState | undefined,
): boolean {
  if (primary?.environmentId === environmentId) {
    return primary.capabilities[capability] === true;
  }
  return (
    runtime?.connectionState === "connected" &&
    runtime.descriptor?.capabilities[capability] === true
  );
}
