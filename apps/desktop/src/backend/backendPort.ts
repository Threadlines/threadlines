import type { DesktopServerExposureMode } from "@threadlines/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as NetService from "@threadlines/shared/Net";

export const DEFAULT_DESKTOP_BACKEND_PORT = 3773;
const MAX_TCP_PORT = 65_535;
const DESKTOP_LOCAL_ONLY_PORT_PROBE_HOSTS = ["127.0.0.1"] as const;
const DESKTOP_NETWORK_ACCESSIBLE_PORT_PROBE_HOSTS = ["0.0.0.0"] as const;

export class DesktopBackendPortUnavailableError extends Data.TaggedError(
  "DesktopBackendPortUnavailableError",
)<{
  readonly startPort: number;
  readonly maxPort: number;
  readonly hosts: readonly string[];
}> {
  override get message() {
    return `No desktop backend port is available on hosts ${this.hosts.join(", ")} between ${this.startPort} and ${this.maxPort}.`;
  }
}

export interface DesktopBackendPortSelection {
  readonly port: number;
  /**
   * True when the port came from the sequential scan rather than from an
   * explicitly configured port. Only scan-selected ports may be moved later.
   */
  readonly selectedByScan: boolean;
}

/**
 * The hosts a candidate backend port has to be bindable on.
 *
 * Network-accessible mode binds the wildcard address, which conflicts with a
 * process holding the same port on any single interface, so it has to be probed
 * as the wildcard rather than as loopback.
 */
export const desktopBackendPortProbeHosts = (mode: DesktopServerExposureMode): readonly string[] =>
  mode === "network-accessible"
    ? DESKTOP_NETWORK_ACCESSIBLE_PORT_PROBE_HOSTS
    : DESKTOP_LOCAL_ONLY_PORT_PROBE_HOSTS;

export const canBindDesktopBackendPort = Effect.fn("desktop.backendPort.canBind")(
  function* (input: { readonly port: number; readonly probeHosts: readonly string[] }) {
    const net = yield* NetService.NetService;
    for (const host of input.probeHosts) {
      if (!(yield* net.canListenOnHost(input.port, host))) {
        return false;
      }
    }
    return true;
  },
);

export const scanForDesktopBackendPort = Effect.fn("desktop.backendPort.scan")(function* (input: {
  readonly probeHosts: readonly string[];
}) {
  for (let port = DEFAULT_DESKTOP_BACKEND_PORT; port <= MAX_TCP_PORT; port += 1) {
    if (yield* canBindDesktopBackendPort({ port, probeHosts: input.probeHosts })) {
      return port;
    }
  }

  return yield* new DesktopBackendPortUnavailableError({
    startPort: DEFAULT_DESKTOP_BACKEND_PORT,
    maxPort: MAX_TCP_PORT,
    hosts: input.probeHosts,
  });
});

export const resolveDesktopBackendPort = Effect.fn("resolveDesktopBackendPort")(function* (input: {
  readonly configuredPort: Option.Option<number>;
  readonly probeHosts: readonly string[];
}): Effect.fn.Return<
  DesktopBackendPortSelection,
  DesktopBackendPortUnavailableError,
  NetService.NetService
> {
  if (Option.isSome(input.configuredPort)) {
    return {
      port: input.configuredPort.value,
      selectedByScan: false,
    };
  }

  return {
    port: yield* scanForDesktopBackendPort({ probeHosts: input.probeHosts }),
    selectedByScan: true,
  };
});
