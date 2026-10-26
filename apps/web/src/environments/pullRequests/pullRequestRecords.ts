/**
 * Keeps each connected computer's pull request records flowing into
 * pullRequestRecordsStore.ts, which every surface showing a pull request reads.
 */
import type { EnvironmentId, PullRequestObservation } from "@threadlines/contracts";

import { knownComputerIds, readConnectedComputerCapability } from "../computerCapabilities";
import { subscribePrimaryEnvironmentDescriptor } from "../primary";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../runtime";
import { receivePullRequestRecord, usePullRequestRecordsStore } from "./pullRequestRecordsStore";

/**
 * Keeps a `pullRequests.subscribeObservations` stream open to every connected
 * computer whose server sends one. The transport resubscribes after a
 * reconnect, and the server answers with every record it holds. Started once,
 * with the environment connections.
 */
export function startPullRequestRecordsSync(options: {
  /**
   * A pull request a computer had open was seen merged or closed. The settled
   * listings only gain rows, so whatever lists them reads again now rather
   * than on its slow poll, and the row lands with its date.
   */
  readonly onSettled: (environmentId: EnvironmentId, record: PullRequestObservation) => void;
}): () => void {
  const streams = new Map<EnvironmentId, () => void>();

  const reconcile = () => {
    const known = knownComputerIds();
    const wanted = new Set(
      known.filter(
        (environmentId) =>
          readConnectedComputerCapability(environmentId, "pullRequestObservations") &&
          readEnvironmentConnection(environmentId) !== null,
      ),
    );
    for (const [environmentId, stop] of streams) {
      if (wanted.has(environmentId)) continue;
      stop();
      streams.delete(environmentId);
    }
    for (const environmentId of wanted) {
      if (streams.has(environmentId)) continue;
      const connection = readEnvironmentConnection(environmentId);
      if (connection === null) continue;
      streams.set(
        environmentId,
        connection.client.pullRequests.subscribeObservations((record) => {
          const { kept, previous } = receivePullRequestRecord(environmentId, record);
          if (kept && previous?.state === "open" && record.state !== "open") {
            options.onSettled(environmentId, record);
          }
        }),
      );
    }
    const { byEnvironmentId } = usePullRequestRecordsStore.getState();
    const forgotten = (Object.keys(byEnvironmentId) as EnvironmentId[]).filter(
      (environmentId) => !known.includes(environmentId),
    );
    if (forgotten.length > 0) {
      const next = { ...byEnvironmentId };
      for (const environmentId of forgotten) delete next[environmentId];
      usePullRequestRecordsStore.setState({ byEnvironmentId: next });
    }
  };

  reconcile();
  const unsubscribers = [
    subscribeEnvironmentConnections(reconcile),
    subscribePrimaryEnvironmentDescriptor(reconcile),
    useSavedEnvironmentRuntimeStore.subscribe(reconcile),
    useSavedEnvironmentRegistryStore.subscribe(reconcile),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    for (const stop of streams.values()) stop();
    streams.clear();
  };
}
