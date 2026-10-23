/**
 * The computer that runs a provider, for the calls made about it: a thread's
 * agent signs in and re-checks on the computer the thread runs on, not on
 * whichever computer the app's settings talk to.
 *
 * `environmentId` names that computer. Null, or the app's own backend's id,
 * means the backend: the desktop app's own server, or on the hosted app (a
 * phone, which has no computer of its own) the computer it's looking at.
 * Kept narrow, off the environment runtime's large module graph, so the
 * notices that call it stay light and browser tests can stand in for a
 * computer.
 *
 * @module providerComputer
 */
import type { EnvironmentId, ServerProvider } from "@threadlines/contracts";
import { useSyncExternalStore } from "react";

import { useServerProviders } from "../rpc/serverState";
import type { WsRpcClient } from "../rpc/wsRpcClient";
import { isPrimaryEnvironmentOnThisComputer } from "./primary/target";
import { readEnvironmentDescriptor, useSavedEnvironmentRuntimeStore } from "./runtime/catalog";
import {
  readBackendEnvironmentConnection,
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "./runtime/service";

export type ProviderAuthClient = WsRpcClient["providerAuth"];

/**
 * The app's backend, or null before it has one (a hosted page not paired
 * yet, a test that mounts a surface on its own). These are read while a
 * surface draws, so asking must never throw.
 */
function readBackendConnection(): ReturnType<typeof readBackendEnvironmentConnection> {
  try {
    return readBackendEnvironmentConnection();
  } catch {
    return null;
  }
}

/** Whether calls about a provider on `environmentId` go to the app's own backend. */
export function isAppBackendEnvironment(environmentId: EnvironmentId | null): boolean {
  return environmentId === null || environmentId === readBackendConnection()?.environmentId;
}

/**
 * Whether the computer that runs the provider is the one this app is on: the
 * desktop app's own server. A sign-in there finishes like any on this
 * computer; anywhere else its pages open on this device and its loopback
 * addresses need pasting back.
 */
export function isProviderComputerThisOne(environmentId: EnvironmentId | null): boolean {
  return isAppBackendEnvironment(environmentId) && isPrimaryEnvironmentOnThisComputer();
}

/**
 * Whether the computer that runs the provider replays a terminal sign-in
 * page's final address itself, pasted from a browser elsewhere. An older
 * server would type it into the sign-in command instead.
 */
export function computerReplaysSignInAddresses(environmentId: EnvironmentId | null): boolean {
  const computerId = environmentId ?? readBackendConnection()?.environmentId ?? null;
  return (
    computerId !== null &&
    readEnvironmentDescriptor(computerId)?.capabilities.signInAddressReplay === true
  );
}

const authClientOverridesForTests = new Map<EnvironmentId | null, ProviderAuthClient>();

/**
 * Browser tests stand in for a computer's server: sign-in calls about its
 * providers go to `client`. Null stands in for the app's own backend.
 */
export function __setProviderAuthClientForTests(
  environmentId: EnvironmentId | null,
  client: ProviderAuthClient,
): void {
  authClientOverridesForTests.set(environmentId, client);
}

export function __resetProviderAuthClientsForTests(): void {
  authClientOverridesForTests.clear();
}

/**
 * The sign-in calls of the computer that runs the provider, or null while
 * this app has no connection to it (a saved computer that is offline, or a
 * phone not paired with any).
 */
export function readProviderAuthClient(
  environmentId: EnvironmentId | null,
): ProviderAuthClient | null {
  const override = authClientOverridesForTests.get(environmentId);
  if (override !== undefined) return override;
  if (isAppBackendEnvironment(environmentId)) {
    return (
      authClientOverridesForTests.get(null) ?? readBackendConnection()?.client.providerAuth ?? null
    );
  }
  return environmentId === null
    ? null
    : (readEnvironmentConnection(environmentId)?.client.providerAuth ?? null);
}

/**
 * `readProviderAuthClient`, followed as the computer connects, reconnects or
 * goes away: a connection rebuilt for a saved computer is a new client, and
 * a subscription on the old one would hear nothing.
 */
export function useProviderAuthClient(
  environmentId: EnvironmentId | null,
): ProviderAuthClient | null {
  return useSyncExternalStore(
    subscribeEnvironmentConnections,
    () => readProviderAuthClient(environmentId),
    () => null,
  );
}

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/**
 * The providers of the computer that runs them, as it last reported: the
 * app's own config for its backend, a saved computer's own config otherwise
 * (empty until it has sent one).
 */
export function useComputerProviders(
  environmentId: EnvironmentId | null,
): ReadonlyArray<ServerProvider> {
  const backendProviders = useServerProviders();
  const savedProviders = useSavedEnvironmentRuntimeStore((state) =>
    environmentId === null ? undefined : state.byId[environmentId]?.serverConfig?.providers,
  );
  return isAppBackendEnvironment(environmentId)
    ? backendProviders
    : (savedProviders ?? NO_PROVIDERS);
}
