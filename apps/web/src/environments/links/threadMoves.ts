/**
 * Moving a thread to a linked computer (docs/design/fleet.md, Part 3), as
 * this app reaches it: the `moves.*` calls go to the computer the thread is
 * on, through this app's own connection to it, and the move is offered only
 * where that computer can make one.
 */
import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@threadlines/contracts";
import { useCallback } from "react";

import type { WsRpcClient } from "../../rpc/wsRpcClient";
import { isMoveThreadsOffered, isThreadMoveOffered } from "../../threadMove";
import type { ThreadMoveStatus } from "../../types";
import { usePrimaryEnvironmentDescriptor } from "../primary";
import {
  readEnvironmentConnection,
  readEnvironmentDescriptor,
  useSavedEnvironmentRuntimeStore,
} from "../runtime";
import { useComputerLinksStore, type ComputerLinksEntry } from "./computerLinks";

export type ThreadMovesClient = WsRpcClient["moves"];

const clientOverridesForTests = new Map<EnvironmentId, ThreadMovesClient>();

/** Browser tests stand in for a computer's server: its moves calls go to `client`. */
export function __setThreadMovesClientForTests(
  environmentId: EnvironmentId,
  client: ThreadMovesClient,
): void {
  clientOverridesForTests.set(environmentId, client);
}

export function __resetThreadMovesForTests(): void {
  clientOverridesForTests.clear();
}

/** The moves calls of this app's connection to a computer, or null without one. */
export function readThreadMovesClient(environmentId: EnvironmentId): ThreadMovesClient | null {
  return (
    clientOverridesForTests.get(environmentId) ??
    readEnvironmentConnection(environmentId)?.client.moves ??
    null
  );
}

/** Like readThreadMovesClient, for a call that can't go on without the connection. */
export function requireThreadMovesClient(
  environmentId: EnvironmentId,
  label: string,
): ThreadMovesClient {
  const client = readThreadMovesClient(environmentId);
  if (client === null) throw new Error(`This app isn't connected to ${label}.`);
  return client;
}

/** A computer's own outbound links, while its stream is live; null otherwise. */
function liveOutbound(entry: ComputerLinksEntry | undefined) {
  return entry?.live ? entry.snapshot.outbound : null;
}

function supportsThreadMove(descriptor: ExecutionEnvironmentDescriptor | null): boolean {
  return descriptor?.capabilities.threadMove === true;
}

/**
 * isThreadMoveOffered for a thread on `environmentId`, read now: for menus
 * built on a click (the sidebar's thread menu).
 */
export function readThreadMoveOffered(
  environmentId: EnvironmentId,
  moveStatus: ThreadMoveStatus | undefined,
): boolean {
  return isThreadMoveOffered({
    supportsThreadMove: supportsThreadMove(readEnvironmentDescriptor(environmentId)),
    outbound: liveOutbound(useComputerLinksStore.getState().byEnvironmentId[environmentId]),
    moveStatus,
  });
}

/** The descriptor of the computer `environmentId`, kept current; null when not known. */
function useEnvironmentDescriptor(
  environmentId: EnvironmentId | null,
): ExecutionEnvironmentDescriptor | null {
  const primary = usePrimaryEnvironmentDescriptor();
  const saved = useSavedEnvironmentRuntimeStore((state) =>
    environmentId === null ? null : (state.byId[environmentId]?.descriptor ?? null),
  );
  if (environmentId === null) return null;
  return primary?.environmentId === environmentId ? primary : saved;
}

/**
 * Whether the computer `environmentId` queues moves (`moves.queue`, Part 3b),
 * kept current. With it every move goes through the queue, a free thread's
 * included; without it, only `moves.start` exists there.
 */
export function useThreadMoveQueueSupported(environmentId: EnvironmentId | null): boolean {
  return useEnvironmentDescriptor(environmentId)?.capabilities.threadMoveQueue === true;
}

/** isThreadMoveOffered for a thread on `environmentId`, kept current. */
export function useThreadMoveOffered(
  environmentId: EnvironmentId | null,
  moveStatus: ThreadMoveStatus | undefined,
): boolean {
  const descriptor = useEnvironmentDescriptor(environmentId);
  const outbound = useComputerLinksStore((state) =>
    environmentId === null ? null : liveOutbound(state.byEnvironmentId[environmentId]),
  );
  if (environmentId === null) return false;
  return isThreadMoveOffered({
    supportsThreadMove: supportsThreadMove(descriptor),
    outbound,
    moveStatus,
  });
}

/**
 * Whether the computer `environmentId` moves several threads at once
 * (`moves.previewMany`, `queueMany`, `setMode`, `batchStatus`, Part 3c),
 * kept current.
 */
export function useThreadMoveBatchSupported(environmentId: EnvironmentId | null): boolean {
  return useEnvironmentDescriptor(environmentId)?.capabilities.threadMoveBatch === true;
}

/**
 * Whether the computer `environmentId` takes moves before its user allows
 * them and answers several at once (`moves.respondMany`, Part 3c), kept current.
 */
export function useThreadMoveStagedApprovalSupported(environmentId: EnvironmentId | null): boolean {
  return useEnvironmentDescriptor(environmentId)?.capabilities.threadMoveStagedApproval === true;
}

/**
 * useThreadMoveStagedApprovalSupported for any computer, as a check: for
 * lists of moves waiting on several computers, which group per computer.
 */
export function useThreadMoveStagedApprovalCheck(): (environmentId: EnvironmentId) => boolean {
  const primary = usePrimaryEnvironmentDescriptor();
  const runtimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  return useCallback(
    (environmentId) => {
      const descriptor =
        primary?.environmentId === environmentId
          ? primary
          : (runtimeById[environmentId]?.descriptor ?? null);
      return descriptor?.capabilities.threadMoveStagedApproval === true;
    },
    [primary, runtimeById],
  );
}

/**
 * isMoveThreadsOffered from `sourceEnvironmentId`, to `targetEnvironmentId`
 * when one is named, kept current.
 */
export function useMoveThreadsOffered(
  sourceEnvironmentId: EnvironmentId | null,
  targetEnvironmentId: EnvironmentId | null,
): boolean {
  const supportsBatch = useThreadMoveBatchSupported(sourceEnvironmentId);
  const outbound = useLiveOutboundLinks(sourceEnvironmentId);
  return (
    sourceEnvironmentId !== null &&
    sourceEnvironmentId !== targetEnvironmentId &&
    isMoveThreadsOffered({ supportsBatch, outbound, targetEnvironmentId })
  );
}

/**
 * A thread's computer's own outbound links, as last heard while its stream is
 * live; null when they aren't heard. The moving thread's notice reads it to
 * tell a move that can't go on.
 */
export function useLiveOutboundLinks(environmentId: EnvironmentId | null) {
  return useComputerLinksStore((state) =>
    environmentId === null ? null : liveOutbound(state.byEnvironmentId[environmentId]),
  );
}
