/**
 * Whether this app's connection to a computer is protected on the wire, so a
 * secret can go over it: project setup's env files and an agent's request for
 * a key both check it before they send. A plain `ws://` address on a network
 * is not protected; the user answers on that computer instead.
 */
import { isProtectedConnectionUrl } from "@threadlines/client-runtime";
import type { EnvironmentId } from "@threadlines/contracts";

import { getPrimaryKnownEnvironment, usePrimaryEnvironmentDescriptor } from "./primary";
import { type SavedEnvironmentRecord, useSavedEnvironmentRegistryStore } from "./runtime";

/**
 * Whether this app's connection to its own server is protected on the wire:
 * the address it reaches it by (the desktop app's loopback, a TLS address),
 * resolved against the page for a same-origin server.
 */
export function isPrimaryConnectionProtected(): boolean {
  try {
    const wsBaseUrl = getPrimaryKnownEnvironment()?.target.wsBaseUrl;
    if (!wsBaseUrl) return false;
    return isProtectedConnectionUrl(new URL(wsBaseUrl, window.location.origin).toString());
  } catch {
    // An address it can't tell is not one to send secrets over.
    return false;
  }
}

/**
 * Whether this app's connection to a saved computer is protected: a "Connect
 * a device" computer's end to end encrypted connection (relay v2, over the
 * relay or a direct route), an SSH tunnel, or a TLS or loopback address. An
 * old phone link (relay v1) is readable at the relay, so it is not.
 */
export function isSavedConnectionProtected(record: SavedEnvironmentRecord): boolean {
  if (record.relay) return "version" in record.relay && record.relay.version === 2;
  if (record.desktopSsh) return true;
  return isProtectedConnectionUrl(record.wsBaseUrl);
}

/**
 * Whether the connection to a computer is protected, kept current: its own
 * server's address, or its saved record's. A computer this app has no record
 * of is not.
 */
export function useConnectionProtected(environmentId: EnvironmentId): boolean {
  const primaryId = usePrimaryEnvironmentDescriptor()?.environmentId ?? null;
  const record = useSavedEnvironmentRegistryStore((state) => state.byId[environmentId]);
  if (primaryId === environmentId) return isPrimaryConnectionProtected();
  return record !== undefined && isSavedConnectionProtected(record);
}
