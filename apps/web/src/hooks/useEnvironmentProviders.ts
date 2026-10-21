import type { EnvironmentId, ServerProvider } from "@threadlines/contracts";
import { useCallback } from "react";

import { usePrimaryEnvironmentId } from "../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { useServerProviders } from "../rpc/serverState";

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/**
 * One computer's provider snapshots, by its environment. Instance ids are
 * named per computer, so the same id can be a different agent on another
 * one: whatever is drawn or named for a computer's thread is looked up on
 * that computer. This computer's come from its own server config, the
 * others' from their saved connection; a computer not connected yet has none.
 */
export function useEnvironmentProviders(): (
  environmentId: EnvironmentId,
) => ReadonlyArray<ServerProvider> {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryProviders = useServerProviders();
  const savedRuntime = useSavedEnvironmentRuntimeStore((state) => state.byId);
  return useCallback(
    (environmentId) =>
      environmentId === primaryEnvironmentId
        ? primaryProviders
        : (savedRuntime[environmentId]?.serverConfig?.providers ?? NO_PROVIDERS),
    [primaryEnvironmentId, primaryProviders, savedRuntime],
  );
}
