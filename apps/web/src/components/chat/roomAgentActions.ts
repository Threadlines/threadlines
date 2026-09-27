/**
 * Changes to a room's agents that the server keeps: the user's name for an
 * agent, and an added agent's model and model options. All go out as
 * `thread.participant.update`.
 */
import type {
  ModelSelection,
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
    readonly modelSelection?: ModelSelection;
    readonly handle?: string;
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
    ...(change.modelSelection !== undefined ? { modelSelection: change.modelSelection } : {}),
    ...(change.handle !== undefined ? { handle: change.handle } : {}),
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

/**
 * Move an added agent to another model, under its name for that model
 * ("GPT-6 Sol 2"), so the other agents are told the same name the room
 * shows. The server refuses while that agent is working or answering.
 * Options picked here for the old model and not sent yet are dropped.
 */
export const changeRoomAgentModel = async (
  threadRef: ScopedThreadRef,
  participantId: ThreadParticipantId,
  modelSelection: ModelSelection,
  handle: string,
) => {
  await updateRoomAgent(threadRef, participantId, { modelSelection, handle });
  useRoomRecipientStore.getState().setAgentOptions(threadRef, participantId, undefined);
};
