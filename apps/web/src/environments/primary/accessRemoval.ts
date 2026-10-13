import type { AuthSessionState } from "@threadlines/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useAtomValue } from "@effect/atom-react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { type DesktopSessionOutcome, ensureDesktopSession, fetchSessionState } from "./auth";

/**
 * A websocket handshake that the server rejects for auth reasons is
 * indistinguishable, from the browser, from one the network dropped: both
 * surface as a generic socket error with close code 1006. Asking the server
 * whether this session still exists is the only reliable way to tell "the
 * computer removed this device" from "the Wi-Fi blinked", and the difference
 * matters — one should stop reconnecting and say so, the other must keep
 * retrying forever.
 *
 * A session that is gone only locks out a device that was paired. The desktop
 * app's own window signs itself back in, so for it a missing session is one
 * that ran out (they last 30 days): the probe has it replaced and answers
 * `active`, or `unknown` when the server could not be asked for a new one yet.
 */
export type PrimaryAccessProbeOutcome = "active" | "removed" | "unknown";

export async function probePrimaryAccess(
  readSessionState: () => Promise<AuthSessionState> = fetchSessionState,
  restoreSession: () => Promise<DesktopSessionOutcome> = ensureDesktopSession,
): Promise<PrimaryAccessProbeOutcome> {
  let session: AuthSessionState;
  try {
    session = await readSessionState();
  } catch {
    // The session endpoint is unreachable, which is exactly what a network
    // outage looks like. Treat it as inconclusive and keep reconnecting.
    return "unknown";
  }
  if (session.authenticated) {
    return "active";
  }

  const restored = await restoreSession();
  if (restored === "unavailable") {
    return "removed";
  }
  return restored === "failed" ? "unknown" : "active";
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
