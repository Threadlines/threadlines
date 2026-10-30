/**
 * Agents outside Threadlines (docs/design/outside-agents.md), as this app
 * manages them: this computer's address for agents, its connections and the
 * sign-ins waiting for the user, from its own server's owner-only
 * `outsideAgents.subscribe` stream. Only this computer: an agent signs in to
 * the server on the computer it runs on, and the user approves it there.
 * Assistants (docs/design/assistants.md) come in through the relay but are
 * approved here the same way: the same stream carries their door's state,
 * the sign-in code showing and their sign-ins waiting.
 *
 * The stream stays open while anything holds it (useOutsideAgentsSync): the
 * app-wide host that shows the approval dialog, and Settings' Agents and
 * Assistants groups. The last one to let go closes it and forgets what it said.
 */
import type {
  OutsideAgentApproveInput,
  OutsideAgentConnection,
  OutsideAgentConnectionId,
  OutsideAgentCreateKeyInput,
  OutsideAgentCreateKeyResult,
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
import { type AssistantSignInCode, nextShownAssistantCode } from "./outsideAgents.logic";
import { usePrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "../primary";
import { getPrimaryEnvironmentConnection } from "../runtime";

export type OutsideAgentsClient = WsRpcClient["outsideAgents"];

/** Asking for an assistant sign-in code: under way, and why the last ask failed. */
export interface AssistantCodeAsk {
  readonly busy: boolean;
  readonly error: string | null;
}

const NO_ASK: AssistantCodeAsk = { busy: false, error: null };

interface OutsideAgentsState {
  /** As this computer's server last told it; null while nothing holds the stream, or before it answers. */
  readonly snapshot: OutsideAgentsSnapshot | null;
  /**
   * The assistant sign-in code Settings shows (nextShownAssistantCode): the
   * snapshot's while it has one, and the last one after it ran out.
   */
  readonly assistantCode: AssistantSignInCode | null;
  /** Settings' "Connect an assistant" and the command palette's ask alike. */
  readonly assistantCodeAsk: AssistantCodeAsk;
}

export const useOutsideAgentsStore = create<OutsideAgentsState>()(() => ({
  snapshot: null,
  assistantCode: null,
  assistantCodeAsk: NO_ASK,
}));

/** This computer's agents, as last heard; null before the first word. */
export function useOutsideAgentsSnapshot(): OutsideAgentsSnapshot | null {
  return useOutsideAgentsStore((state) => state.snapshot);
}

/** The assistant sign-in code to show, live or run out; null: none. */
export function useShownAssistantCode(): AssistantSignInCode | null {
  return useOutsideAgentsStore((state) => state.assistantCode);
}

export function useAssistantCodeAsk(): AssistantCodeAsk {
  return useOutsideAgentsStore((state) => state.assistantCodeAsk);
}

/** Takes a new snapshot, and with it the code to show. Null: the stream closed, and both are forgotten. */
function setSnapshot(snapshot: OutsideAgentsSnapshot | null): void {
  useOutsideAgentsStore.setState((state) =>
    snapshot === null
      ? { snapshot, assistantCode: null, assistantCodeAsk: NO_ASK }
      : {
          snapshot,
          assistantCode: nextShownAssistantCode(
            state.assistantCode,
            snapshot.assistants.code,
            Date.now(),
          ),
        },
  );
}

/** Applies what an answered call changed ahead of the stream's next snapshot, which wins. */
function patchSnapshot(patch: (snapshot: OutsideAgentsSnapshot) => OutsideAgentsSnapshot): void {
  const { snapshot } = useOutsideAgentsStore.getState();
  if (snapshot !== null) setSnapshot(patch(snapshot));
}

function readClient(): OutsideAgentsClient {
  return getPrimaryEnvironmentConnection().client.outsideAgents;
}

let holders = 0;
let stopStream: (() => void) | null = null;

function hold(): () => void {
  holders += 1;
  if (holders === 1) {
    stopStream = readClient().subscribe(setSnapshot);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders > 0) return;
    stopStream?.();
    stopStream = null;
    setSnapshot(null);
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

/** The snapshot without one waiting sign-in, a local agent's or an assistant's. */
function withoutSignIn(
  snapshot: OutsideAgentsSnapshot,
  requestId: OutsideAgentRequestId,
): OutsideAgentsSnapshot {
  return {
    ...snapshot,
    pending: snapshot.pending.filter((request) => request.requestId !== requestId),
    assistants: {
      ...snapshot.assistants,
      signIns: snapshot.assistants.signIns.filter((signIn) => signIn.requestId !== requestId),
    },
  };
}

/**
 * Allows a waiting sign-in with what the user picked; the agent's browser
 * page (or, for an assistant, the page that typed the code) then finishes it.
 */
export async function approveOutsideAgent(
  input: OutsideAgentApproveInput,
): Promise<OutsideAgentConnection> {
  const connection = await readClient().approve(input);
  patchSnapshot((snapshot) => withoutSignIn(snapshot, input.requestId));
  return connection;
}

export async function denyOutsideAgent(requestId: OutsideAgentRequestId): Promise<void> {
  await readClient().deny({ requestId });
  patchSnapshot((snapshot) => withoutSignIn(snapshot, requestId));
}

/** Denies every waiting sign-in, of both kinds, and turns new ones away for a while. */
export async function denyAllOutsideAgents(): Promise<void> {
  await readClient().denyAll();
  patchSnapshot((snapshot) => ({
    ...snapshot,
    pending: [],
    assistants: { ...snapshot.assistants, signIns: [] },
  }));
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

/**
 * Shows a new sign-in code for an assistant, replacing any code showing, if
 * the door is open (Settings says why when it isn't): the user types it into
 * the page the assistant opened. The snapshot carries it while it lasts, and
 * drops it once a sign-in used it. Settings' "Connect an assistant" and the
 * command palette's both ask here; Settings shows the ask under way and why
 * it failed.
 */
export async function startAssistantCode(): Promise<void> {
  const { snapshot, assistantCodeAsk } = useOutsideAgentsStore.getState();
  if (assistantCodeAsk.busy || snapshot?.assistants.status !== "ready") return;
  useOutsideAgentsStore.setState({ assistantCodeAsk: { busy: true, error: null } });
  try {
    const code = await readClient().assistantCode();
    patchSnapshot((current) => ({ ...current, assistants: { ...current.assistants, code } }));
    useOutsideAgentsStore.setState({ assistantCodeAsk: NO_ASK });
  } catch (cause) {
    useOutsideAgentsStore.setState({
      assistantCodeAsk: {
        busy: false,
        error: describeOutsideAgentFailure(cause, "Couldn't get a code. Try again."),
      },
    });
  }
}

/** Forgets the code showing: the page can't use it any more, and Settings stops showing it. */
export async function cancelAssistantCode(): Promise<void> {
  const live = useOutsideAgentsStore.getState().snapshot?.assistants.code ?? null;
  if (live !== null) {
    await readClient().assistantCodeCancel();
    patchSnapshot((snapshot) => ({
      ...snapshot,
      assistants: { ...snapshot.assistants, code: null },
    }));
  }
  useOutsideAgentsStore.setState({ assistantCode: null, assistantCodeAsk: NO_ASK });
}

/**
 * Makes a key-signed assistant connection. The key is in the result only:
 * show it once and let it go. Nothing here keeps it, and the snapshot gets
 * only the connection.
 */
export async function createAssistantKey(
  input: OutsideAgentCreateKeyInput,
): Promise<OutsideAgentCreateKeyResult> {
  const result = await readClient().createKey(input);
  patchSnapshot((snapshot) => ({
    ...snapshot,
    connections: [
      result.connection,
      ...snapshot.connections.filter(
        (connection) => connection.connectionId !== result.connection.connectionId,
      ),
    ],
  }));
  return result;
}
