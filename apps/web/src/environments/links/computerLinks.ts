/**
 * Computer links as this app sees them (docs/design/fleet.md, Rev 4).
 *
 * Every connected computer whose server reports `computerLinks` streams its
 * links snapshot (`links.subscribe`): its own links to other computers
 * (outbound), the links other computers have to it with their access
 * settings (inbound), and the threads waiting for its user's Allow. The last
 * snapshot stays after the computer goes away, marked not live, so the Fleet
 * page can still show its settings (disabled) while it is offline. A computer
 * removed from this app takes its snapshot with it.
 *
 * Every change is made on the computer that holds it, through this app's own
 * connection to that computer: an access setting on the computer whose
 * inbound link it is, a new link on the asking computer once the other one
 * made an invite, each half of an unlink on its own computer.
 */
import type {
  ComputerLinksSnapshot,
  EnvironmentId,
  LinksRemoveInput,
  LinksRemoveResult,
  LinksRespondRequestInput,
  LinksSetAccessInput,
  OutboundComputerLink,
} from "@threadlines/contracts";
import { create } from "zustand";

import type { WsRpcClient } from "../../rpc/wsRpcClient";
import { readPrimaryEnvironmentDescriptor } from "../primary";
import {
  listEnvironmentConnections,
  readEnvironmentConnection,
  readEnvironmentDescriptor,
  subscribeEnvironmentConnections,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../runtime";

/** One computer's links, as last heard from it. */
export interface ComputerLinksEntry {
  readonly snapshot: ComputerLinksSnapshot;
  /** The stream is up, so this is current. False: the last one this app saw. */
  readonly live: boolean;
}

interface ComputerLinksStoreState {
  readonly byEnvironmentId: Readonly<Record<string, ComputerLinksEntry>>;
  readonly put: (environmentId: EnvironmentId, snapshot: ComputerLinksSnapshot) => void;
  readonly markStale: (environmentId: EnvironmentId) => void;
  readonly forget: (environmentId: EnvironmentId) => void;
  readonly reset: () => void;
}

export const useComputerLinksStore = create<ComputerLinksStoreState>()((set) => ({
  byEnvironmentId: {},
  put: (environmentId, snapshot) =>
    set((state) => ({
      byEnvironmentId: { ...state.byEnvironmentId, [environmentId]: { snapshot, live: true } },
    })),
  markStale: (environmentId) =>
    set((state) => {
      const current = state.byEnvironmentId[environmentId];
      if (current === undefined || !current.live) return state;
      return {
        byEnvironmentId: { ...state.byEnvironmentId, [environmentId]: { ...current, live: false } },
      };
    }),
  forget: (environmentId) =>
    set((state) => {
      if (state.byEnvironmentId[environmentId] === undefined) return state;
      const { [environmentId]: _forgotten, ...rest } = state.byEnvironmentId;
      return { byEnvironmentId: rest };
    }),
  reset: () => set({ byEnvironmentId: {} }),
}));

export type ComputerLinksClient = WsRpcClient["links"];

const clientOverridesForTests = new Map<EnvironmentId, ComputerLinksClient>();

/** Browser tests stand in for a computer's server: its links calls go to `client`. */
export function __setComputerLinksClientForTests(
  environmentId: EnvironmentId,
  client: ComputerLinksClient,
): void {
  clientOverridesForTests.set(environmentId, client);
}

export function __resetComputerLinksForTests(): void {
  clientOverridesForTests.clear();
  useComputerLinksStore.getState().reset();
}

/** The links calls of this app's connection to a computer, or null without one. */
export function readComputerLinksClient(environmentId: EnvironmentId): ComputerLinksClient | null {
  return (
    clientOverridesForTests.get(environmentId) ??
    readEnvironmentConnection(environmentId)?.client.links ??
    null
  );
}

/**
 * Whether a computer's server takes links calls: true or false once this app
 * has its description, null before (never connected).
 */
export function readComputerLinksSupport(environmentId: EnvironmentId): boolean | null {
  const descriptor = readEnvironmentDescriptor(environmentId);
  return descriptor === null ? null : descriptor.capabilities.computerLinks === true;
}

function isConnectedNow(environmentId: EnvironmentId): boolean {
  if (readPrimaryEnvironmentDescriptor()?.environmentId === environmentId) return true;
  return (
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.connectionState === "connected"
  );
}

function isKnownComputer(environmentId: string): boolean {
  return (
    readPrimaryEnvironmentDescriptor()?.environmentId === environmentId ||
    useSavedEnvironmentRegistryStore.getState().byId[environmentId as EnvironmentId] !== undefined
  );
}

/**
 * Keeps a `links.subscribe` stream open to every connected computer that
 * supports links, for as long as it stays connected. Started once, with the
 * environment connections.
 */
export function startComputerLinksSync(): () => void {
  const streams = new Map<EnvironmentId, () => void>();
  const store = useComputerLinksStore.getState;

  const reconcile = () => {
    const wanted = new Set<EnvironmentId>();
    for (const connection of listEnvironmentConnections()) {
      const environmentId = connection.environmentId;
      if (readComputerLinksSupport(environmentId) !== true) continue;
      if (!isConnectedNow(environmentId)) continue;
      wanted.add(environmentId);
    }
    for (const [environmentId, stop] of streams) {
      if (wanted.has(environmentId)) continue;
      stop();
      streams.delete(environmentId);
      store().markStale(environmentId);
    }
    for (const environmentId of wanted) {
      if (streams.has(environmentId)) continue;
      const connection = readEnvironmentConnection(environmentId);
      if (connection === null) continue;
      streams.set(
        environmentId,
        connection.client.links.subscribe((snapshot) => store().put(environmentId, snapshot), {
          onResubscribe: () => store().markStale(environmentId),
        }),
      );
    }
    for (const environmentId of Object.keys(store().byEnvironmentId)) {
      if (!isKnownComputer(environmentId)) store().forget(environmentId as EnvironmentId);
    }
  };

  reconcile();
  const unsubscribers = [
    subscribeEnvironmentConnections(reconcile),
    useSavedEnvironmentRuntimeStore.subscribe(reconcile),
    useSavedEnvironmentRegistryStore.subscribe(reconcile),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    for (const stop of streams.values()) stop();
    streams.clear();
  };
}

/** What went wrong, in the words the server or the transport gave. */
export function describeComputerLinkFailure(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "detail" in error && typeof error.detail === "string") {
    return error.detail;
  }
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return fallback;
}

function requireClient(environmentId: EnvironmentId, label: string): ComputerLinksClient {
  const client = readComputerLinksClient(environmentId);
  if (client === null) throw new Error(`This app isn't connected to ${label}.`);
  return client;
}

/** A computer as an action names it: where to call, and what to call it in a message. */
export interface ComputerLinkTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** Changes what an inbound link may do, on the computer whose link it is. */
export async function setComputerLinkAccess(
  worker: ComputerLinkTarget,
  input: LinksSetAccessInput,
): Promise<void> {
  await requireClient(worker.environmentId, worker.label).setAccess(input);
}

/** Allow or Deny a thread another computer asked to start, on the computer it would run on. */
export async function respondToComputerLinkRequest(
  worker: ComputerLinkTarget,
  input: LinksRespondRequestInput,
): Promise<void> {
  await requireClient(worker.environmentId, worker.label).respondRequest(input);
}

/**
 * Links one direction: `asker`'s agents may then start work on `worker`. The
 * worker makes a single-use invite and the asker's server claims it; the new
 * link starts at the worker's default access (Ask first).
 */
export async function linkComputer(input: {
  readonly asker: ComputerLinkTarget;
  readonly worker: ComputerLinkTarget;
}): Promise<OutboundComputerLink> {
  const askerClient = requireClient(input.asker.environmentId, input.asker.label);
  const workerClient = requireClient(input.worker.environmentId, input.worker.label);
  const invite = await workerClient.createInvite();
  return askerClient.accept({ invite });
}

/** Removes one half of a link on the computer that holds it. */
export async function removeComputerLinkHalf(
  holder: ComputerLinkTarget,
  input: LinksRemoveInput,
): Promise<LinksRemoveResult> {
  return requireClient(holder.environmentId, holder.label).remove(input);
}

/** One direction of a Link: null `error` when it worked. */
export interface ComputerLinkDirectionResult {
  readonly asker: ComputerLinkTarget;
  readonly worker: ComputerLinkTarget;
  readonly error: string | null;
}

/**
 * Links the given directions at once; each reports its own result, so a
 * failed one can be retried on its own.
 */
export async function linkComputerDirections(
  directions: ReadonlyArray<{
    readonly asker: ComputerLinkTarget;
    readonly worker: ComputerLinkTarget;
  }>,
): Promise<ComputerLinkDirectionResult[]> {
  const results = await Promise.allSettled(directions.map((direction) => linkComputer(direction)));
  return directions.map((direction, index) => {
    const result = results[index]!;
    return {
      ...direction,
      error:
        result.status === "fulfilled"
          ? null
          : describeComputerLinkFailure(result.reason, "The link couldn't be made."),
    };
  });
}

/** A half an unlink removes: on `holder`, for one direction of the pair. */
export interface ComputerUnlinkStep<D extends string> {
  readonly holder: ComputerLinkTarget;
  readonly direction: D;
  readonly input: LinksRemoveInput;
}

/** How one direction came out: removed, waiting for the other computer, or failed. */
export interface ComputerUnlinkResult {
  readonly failed: string | null;
  /** A computer's half that waits for the other one, by the asking computer's word. */
  readonly pending: boolean;
}

/**
 * Removes the halves in order (inbound ones first). An outbound half is told
 * its other half is gone only if this run removed it or it was already gone:
 * if that removal failed, its computer asks the other one itself.
 */
export async function runComputerUnlink<D extends string>(
  steps: ReadonlyArray<ComputerUnlinkStep<D>>,
): Promise<Map<D, ComputerUnlinkResult>> {
  const results = new Map<D, ComputerUnlinkResult>();
  const inboundFailed = new Set<D>();
  const record = (direction: D, change: Partial<ComputerUnlinkResult>) => {
    const current = results.get(direction) ?? { failed: null, pending: false };
    results.set(direction, {
      failed: change.failed ?? current.failed,
      pending: change.pending ?? current.pending,
    });
  };
  for (const step of steps) {
    let input = step.input;
    if (input.direction === "outbound" && inboundFailed.has(step.direction)) {
      const { otherHalfRemoved: _dropped, ...rest } = input;
      input = rest;
    }
    try {
      const result = await removeComputerLinkHalf(step.holder, input);
      record(step.direction, { pending: result.otherComputer === "pending" });
    } catch (error) {
      if (input.direction === "inbound") inboundFailed.add(step.direction);
      record(step.direction, {
        failed: describeComputerLinkFailure(error, `${step.holder.label} couldn't remove it.`),
      });
    }
  }
  return results;
}
