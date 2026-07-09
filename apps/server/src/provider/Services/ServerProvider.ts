import type { ServerProvider } from "@threadlines/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export interface ServerProviderShape {
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  /**
   * Apply an out-of-band update to the current snapshot without running a
   * probe — e.g. folding a mid-turn rate-limit notification into
   * `accountUsage`. The patch returns the next snapshot, or `null` to leave
   * the snapshot untouched (nothing is published).
   */
  readonly patchSnapshot: (
    patch: (current: ServerProvider) => ServerProvider | null,
  ) => Effect.Effect<void>;
}
