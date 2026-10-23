/**
 * Re-checks one provider's status on the computer that runs it, behind a
 * narrow module so the notices that call it stay off the environment
 * runtime's large module graph (and tests can mock this).
 *
 * @module providerStatusRefresh
 */
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderUpdatedPayload,
} from "@threadlines/contracts";

import { ensureLocalApi } from "../localApi";
import { applyProvidersUpdated } from "../rpc/serverState";
import { readBackendEnvironmentConnection, readEnvironmentConnection } from "./runtime/service";

/**
 * A thread on another computer asks that computer, not the one the app's
 * settings talk to; its own config stream then brings the answer to its
 * threads. The app's own backend (also when `environmentId` is null, with
 * nothing open yet) answers through the local API, and its answer lands in
 * the app-level config at once.
 */
export async function refreshProviderStatus(input: {
  readonly environmentId: EnvironmentId | null;
  readonly instanceId: ProviderInstanceId;
}): Promise<ServerProviderUpdatedPayload> {
  const { environmentId, instanceId } = input;
  if (
    environmentId === null ||
    environmentId === readBackendEnvironmentConnection()?.environmentId
  ) {
    const payload = await ensureLocalApi().server.refreshProviders({ instanceId });
    applyProvidersUpdated(payload);
    return payload;
  }
  const connection = readEnvironmentConnection(environmentId);
  if (connection === null) {
    throw new Error("The computer this thread runs on isn't connected right now.");
  }
  return await connection.client.server.refreshProviders({ instanceId });
}
