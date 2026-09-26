/**
 * Changes to a room's agents that the server keeps: the user's name for an
 * agent, and an added agent's model options. Both go out as
 * `thread.participant.update`.
 */
import type {
  ProviderOptionSelection,
  ScopedThreadRef,
  ThreadParticipantId,
} from "@threadlines/contracts";

import { readEnvironmentApi } from "~/environmentApi";
import { newCommandId } from "~/lib/utils";
import { useRoomRecipientStore } from "../../rooms";

const updateRoomAgent = async (
  threadRef: ScopedThreadRef,
  participantId: ThreadParticipantId | null,
  change: {
    readonly role?: string | null;
    readonly modelOptions?: ReadonlyArray<ProviderOptionSelection>;
  },
) => {
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) {
    throw new Error("This computer is not connected.");
  }
  await api.orchestration.dispatchCommand({
    type: "thread.participant.update",
    commandId: newCommandId(),
    threadId: threadRef.threadId,
    participantId,
    ...(change.role !== undefined ? { role: change.role } : {}),
    ...(change.modelOptions !== undefined ? { modelOptions: [...change.modelOptions] } : {}),
    createdAt: new Date().toISOString(),
  });
};

/** Name a room agent ("Reviewer"); null clears the name. */
export const renameRoomAgent = (
  threadRef: ScopedThreadRef,
  participantId: ThreadParticipantId | null,
  role: string | null,
) => updateRoomAgent(threadRef, participantId, { role });

/**
 * Pick model options (reasoning and the like) for an added agent. The
 * composer shows them at once; the server keeps them on the agent, so a
 * reload or another device sees the same choice.
 */
export const pickRoomAgentOptions = (
  threadRef: ScopedThreadRef,
  participantId: ThreadParticipantId,
  options: ReadonlyArray<ProviderOptionSelection>,
) => {
  useRoomRecipientStore.getState().setAgentOptions(threadRef, participantId, options);
  void updateRoomAgent(threadRef, participantId, { modelOptions: options }).catch(() => undefined);
};
