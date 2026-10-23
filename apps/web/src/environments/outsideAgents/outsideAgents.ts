/**
 * Agents outside Threadlines (docs/design/outside-agents.md), as this app
 * manages them: this computer's address for agents, its connections and the
 * sign-ins waiting for the user, from its own server's owner-only
 * `outsideAgents.subscribe` stream. Only this computer: an agent signs in to
 * the server on the computer it runs on, and the user approves it there.
 *
 * The stream stays open while anything holds it (useOutsideAgentsSync): the
 * app-wide host that shows the approval dialog, and Settings' Agents group.
 * The last one to let go closes it and forgets what it said.
 */
import type {
  OutsideAgentApproveInput,
  OutsideAgentConnection,
  OutsideAgentConnectionId,
  OutsideAgentRequestId,
  OutsideAgentsSnapshot,
  OutsideAgentUpdateInput,
} from "@threadlines/contracts";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { usePrimarySessionAccess } from "../../hooks/useAuthAccess";
import type { WsRpcClient } from "../../rpc/wsRpcClient";
import { selectProjectsForEnvironment, useStore } from "../../store";
import type { Project } from "../../types";
import { describeComputerLinkFailure } from "../links/computerLinks";
import { usePrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "../primary";
import { getPrimaryEnvironmentConnection } from "../runtime";

export type OutsideAgentsClient = WsRpcClient["outsideAgents"];

interface OutsideAgentsState {
  /** As this computer's server last told it; null while nothing holds the stream, or before it answers. */
  readonly snapshot: OutsideAgentsSnapshot | null;
}

export const useOutsideAgentsStore = create<OutsideAgentsState>()(() => ({ snapshot: null }));

/** This computer's agents, as last heard; null before the first word. */
export function useOutsideAgentsSnapshot(): OutsideAgentsSnapshot | null {
  return useOutsideAgentsStore((state) => state.snapshot);
}

/** Applies what an answered call changed ahead of the stream's next snapshot, which wins. */
function patchSnapshot(patch: (snapshot: OutsideAgentsSnapshot) => OutsideAgentsSnapshot): void {
  const { snapshot } = useOutsideAgentsStore.getState();
  if (snapshot !== null) useOutsideAgentsStore.setState({ snapshot: patch(snapshot) });
}

function readClient(): OutsideAgentsClient {
  return getPrimaryEnvironmentConnection().client.outsideAgents;
}

let holders = 0;
let stopStream: (() => void) | null = null;

function hold(): () => void {
  holders += 1;
  if (holders === 1) {
    stopStream = readClient().subscribe((snapshot) => useOutsideAgentsStore.setState({ snapshot }));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders > 0) return;
    stopStream?.();
    stopStream = null;
    useOutsideAgentsStore.setState({ snapshot: null });
  };
}

/** Keeps this computer's agents stream open while `enabled` (see useOutsideAgentsAvailable). */
export function useOutsideAgentsSync(enabled: boolean): void {
  useEffect(() => (enabled ? hold() : undefined), [enabled]);
}

/**
 * Whether this window manages this computer's outside agents: its server
 * takes them (`outsideAgents`) and this window is its owner. Phones and the
 * devices an owner let in are never shown them.
 */
export function useOutsideAgentsAvailable(): boolean {
  const capable = usePrimaryEnvironmentDescriptor()?.capabilities.outsideAgents === true;
  return usePrimarySessionAccess(capable).role === "owner" && capable;
}

/**
 * This computer's projects an outside agent can be given, by name: every one
 * but the hidden one General Chats live in.
 */
export function useThisComputerProjects(): ReadonlyArray<Project> {
  const environmentId = usePrimaryEnvironmentId();
  const projects = useStore(
    useShallow((state) => selectProjectsForEnvironment(state, environmentId)),
  );
  return useMemo(
    () =>
      projects
        .filter((project) => project.kind !== "general-chat")
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    [projects],
  );
}

/** What went wrong, in the words the server or the transport gave. */
export function describeOutsideAgentFailure(error: unknown, fallback: string): string {
  return describeComputerLinkFailure(error, fallback);
}

/** Allows a waiting sign-in with what the user picked; the agent's browser page then finishes it. */
export async function approveOutsideAgent(
  input: OutsideAgentApproveInput,
): Promise<OutsideAgentConnection> {
  const connection = await readClient().approve(input);
  patchSnapshot((snapshot) => ({
    ...snapshot,
    pending: snapshot.pending.filter((request) => request.requestId !== input.requestId),
  }));
  return connection;
}

export async function denyOutsideAgent(requestId: OutsideAgentRequestId): Promise<void> {
  await readClient().deny({ requestId });
  patchSnapshot((snapshot) => ({
    ...snapshot,
    pending: snapshot.pending.filter((request) => request.requestId !== requestId),
  }));
}

/** Denies every waiting sign-in and turns new ones away for a while. */
export async function denyAllOutsideAgents(): Promise<void> {
  await readClient().denyAll();
  patchSnapshot((snapshot) => ({ ...snapshot, pending: [] }));
}

/** Ends Deny all's quiet period early. */
export async function resumeOutsideAgentRequests(): Promise<void> {
  await readClient().resumeRequests();
  patchSnapshot((snapshot) => ({ ...snapshot, quietUntil: null }));
}

/** Changes what a connection may do; its next call is checked against it. */
export async function updateOutsideAgent(
  input: OutsideAgentUpdateInput,
): Promise<OutsideAgentConnection> {
  const connection = await readClient().update(input);
  patchSnapshot((snapshot) => ({
    ...snapshot,
    connections: snapshot.connections.map((candidate) =>
      candidate.connectionId === connection.connectionId ? connection : candidate,
    ),
  }));
  return connection;
}

/** Removes a connection: its next call is refused, and it has to sign in again. */
export async function removeOutsideAgent(connectionId: OutsideAgentConnectionId): Promise<void> {
  await readClient().remove({ connectionId });
  patchSnapshot((snapshot) => ({
    ...snapshot,
    connections: snapshot.connections.filter(
      (connection) => connection.connectionId !== connectionId,
    ),
  }));
}
