import type { AdvertisedEndpoint } from "@threadlines/contracts";

/** The Tailscale HTTPS address the desktop app advertises, when Tailscale serves this computer. */
export function isTailscaleHttpsEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.id.startsWith("tailscale-magicdns:");
}

/**
 * Whether other devices can reach this computer directly, on its network or
 * through Tailscale, which a one-time link needs. Settings › Connections
 * offers the link only then, and the settings search finds it only then.
 */
export function isRemotelyReachable(input: {
  readonly networkAccessible: boolean;
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
}): boolean {
  return (
    input.networkAccessible ||
    input.endpoints.find(isTailscaleHttpsEndpoint)?.status === "available"
  );
}
