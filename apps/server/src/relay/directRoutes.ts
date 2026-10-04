import { networkInterfaces } from "node:os";

import { formatHostForUrl, isLoopbackHost, isWildcardHost } from "../startupAccess.ts";

type NetworkInterfacesMap = ReturnType<typeof networkInterfaces>;

/** The direct-connection endpoint a device dials, under this server's address. */
export function directRoutePath(deviceId: string): string {
  return `/relay/direct/${encodeURIComponent(deviceId)}`;
}

/**
 * Where a "Connect a device" device can reach this server without the relay:
 * every external IPv4 address when the server listens on all interfaces
 * (Same network on), the explicit address it was started on, and the
 * Tailscale HTTPS name when Tailscale Serve is on. A loopback-only server
 * offers just Tailscale. Routes are hints: the end-to-end handshake decides
 * whether the far end is really this computer.
 */
export function computeDirectRoutes(input: {
  readonly bindHost: string | undefined;
  readonly port: number;
  readonly deviceId: string;
  readonly tailscaleHttpsBaseUrl: string | null;
  readonly interfaces?: NetworkInterfacesMap;
}): ReadonlyArray<string> {
  const path = directRoutePath(input.deviceId);
  const routes: Array<string> = [];
  if (input.bindHost === undefined || isWildcardHost(input.bindHost)) {
    const interfaces = input.interfaces ?? networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      for (const entry of entries ?? []) {
        // Older Node versions report the family as a number.
        const family = String(entry.family);
        if (entry.internal || (family !== "IPv4" && family !== "4")) continue;
        if (entry.address.startsWith("169.254.")) continue;
        routes.push(`ws://${entry.address}:${input.port}${path}`);
      }
    }
  } else if (!isLoopbackHost(input.bindHost)) {
    routes.push(`ws://${formatHostForUrl(input.bindHost)}:${input.port}${path}`);
  }
  if (input.tailscaleHttpsBaseUrl) {
    const url = new URL(input.tailscaleHttpsBaseUrl);
    url.protocol = "wss:";
    url.pathname = path;
    routes.push(url.toString());
  }
  return [...new Set(routes)];
}
