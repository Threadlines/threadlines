/**
 * Whether a computer this app knows can do something now: connected to this
 * app, and its server reporting the capability (older servers leave theirs
 * out). The app's own computer is connected as long as the app is running.
 */
import type { EnvironmentId, ExecutionEnvironmentCapabilities } from "@threadlines/contracts";

import { readPrimaryEnvironmentDescriptor } from "./primary";
import { useSavedEnvironmentRuntimeStore } from "./runtime";

export function readConnectedComputerCapability(
  environmentId: EnvironmentId,
  capability: keyof ExecutionEnvironmentCapabilities,
): boolean {
  const primary = readPrimaryEnvironmentDescriptor();
  if (primary?.environmentId === environmentId) {
    return primary.capabilities[capability] === true;
  }
  const runtime = useSavedEnvironmentRuntimeStore.getState().byId[environmentId];
  return (
    runtime?.connectionState === "connected" &&
    runtime.descriptor?.capabilities[capability] === true
  );
}
