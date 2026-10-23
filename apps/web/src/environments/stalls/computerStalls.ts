/**
 * Each computer's latest stall, as its server reports it once it answers
 * again (`subscribeServerStalls`): a freeze, or a sleep. Kept per computer
 * while the app runs, timed on this app's clock, never stored. The notice
 * (ComputerStallNotices) and Fleet's note beside the computer read it here.
 */
import { type ReceivedComputerStall, receiveComputerStall } from "@threadlines/client-runtime";
import type { EnvironmentId, ServerStall } from "@threadlines/contracts";
import { create } from "zustand";

import { readConnectedComputerCapability } from "../computerCapabilities";
import {
  readPrimaryEnvironmentDescriptor,
  subscribePrimaryEnvironmentDescriptor,
} from "../primary";
import {
  readEnvironmentConnection,
  readLocalEnvironmentId,
  subscribeEnvironmentConnections,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../runtime";

interface ComputerStallsState {
  readonly byEnvironmentId: Readonly<Partial<Record<EnvironmentId, ReceivedComputerStall>>>;
}

export const useComputerStallsStore = create<ComputerStallsState>(() => ({
  byEnvironmentId: {},
}));

/** Records a report. A resubscribe repeats the latest one, which keeps its first timing. */
export function receiveServerStall(
  environmentId: EnvironmentId,
  stall: ServerStall,
  receivedAtMs = Date.now(),
): void {
  const { byEnvironmentId } = useComputerStallsStore.getState();
  if (byEnvironmentId[environmentId]?.stall.id === stall.id) return;
  useComputerStallsStore.setState({
    byEnvironmentId: {
      ...byEnvironmentId,
      [environmentId]: receiveComputerStall(stall, receivedAtMs),
    },
  });
}

function knownComputerIds(): EnvironmentId[] {
  const primary = readPrimaryEnvironmentDescriptor()?.environmentId;
  const saved = Object.keys(useSavedEnvironmentRegistryStore.getState().byId) as EnvironmentId[];
  return primary === undefined ? saved : [primary, ...saved.filter((id) => id !== primary)];
}

/** A computer as a stall notice names it, and whether it is the one the app runs on. */
export function readStallComputer(environmentId: EnvironmentId): {
  readonly name: string;
  readonly thisComputer: boolean;
} {
  const primary = readPrimaryEnvironmentDescriptor();
  const name =
    useSavedEnvironmentRegistryStore.getState().byId[environmentId]?.label ??
    (primary?.environmentId === environmentId ? primary.label : null) ??
    "A computer";
  return { name, thisComputer: readLocalEnvironmentId() === environmentId };
}

/**
 * Keeps a `subscribeServerStalls` stream open to every connected computer
 * whose server reports stalls, for as long as it stays connected. The
 * transport resubscribes after a reconnect, and the server answers with its
 * latest stall: the one that dropped the connection. Started once, with the
 * environment connections.
 */
export function startComputerStallsSync(): () => void {
  const streams = new Map<EnvironmentId, () => void>();

  const reconcile = () => {
    const known = knownComputerIds();
    const wanted = new Set(
      known.filter(
        (environmentId) =>
          readConnectedComputerCapability(environmentId, "stallReports") &&
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
        connection.client.server.subscribeStalls((stall) =>
          receiveServerStall(environmentId, stall),
        ),
      );
    }
    const { byEnvironmentId } = useComputerStallsStore.getState();
    const forgotten = (Object.keys(byEnvironmentId) as EnvironmentId[]).filter(
      (environmentId) => !known.includes(environmentId),
    );
    if (forgotten.length > 0) {
      const next = { ...byEnvironmentId };
      for (const environmentId of forgotten) delete next[environmentId];
      useComputerStallsStore.setState({ byEnvironmentId: next });
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
