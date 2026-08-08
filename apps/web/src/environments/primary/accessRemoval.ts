import type { AuthSessionState } from "@threadlines/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useAtomValue } from "@effect/atom-react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { fetchSessionState } from "./auth";

/**
 * A websocket handshake that the server rejects for auth reasons is
 * indistinguishable, from the browser, from one the network dropped: both
 * surface as a generic socket error with close code 1006. Asking the server
 * whether this session still exists is the only reliable way to tell "the
 * computer removed this device" from "the Wi-Fi blinked", and the difference
 * matters — one should stop reconnecting and say so, the other must keep
 * retrying forever.
 */
export type PrimaryAccessProbeOutcome = "active" | "removed" | "unknown";

export async function probePrimaryAccess(
  readSessionState: () => Promise<AuthSessionState> = fetchSessionState,
): Promise<PrimaryAccessProbeOutcome> {
  try {
    const session = await readSessionState();
    return session.authenticated ? "active" : "removed";
  } catch {
    // The session endpoint is unreachable, which is exactly what a network
    // outage looks like. Treat it as inconclusive and keep reconnecting.
    return "unknown";
  }
}

const primaryAccessRemovedAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("primary-access-removed"),
);

export function isPrimaryAccessRemoved(): boolean {
  return appAtomRegistry.get(primaryAccessRemovedAtom);
}

export function setPrimaryAccessRemoved(removed: boolean): void {
  if (appAtomRegistry.get(primaryAccessRemovedAtom) === removed) {
    return;
  }
  appAtomRegistry.set(primaryAccessRemovedAtom, removed);
}

export function usePrimaryAccessRemoved(): boolean {
  return useAtomValue(primaryAccessRemovedAtom);
}
