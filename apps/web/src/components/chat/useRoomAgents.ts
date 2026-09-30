/**
 * The agents in a thread as the model picker lists them, and the changes the
 * picker makes to them: who the next message goes to, adding, naming, moving
 * to another model, removing.
 *
 * A saved thread keeps its agents on the server; a new thread keeps them in
 * its draft until the first message creates the thread with them
 * (thread.create participants). Both look the same to the picker.
 */
import type {
  ClientOrchestrationCommand,
  ModelSelection,
  OrchestrationThreadParticipant,
  ProviderInstanceId,
  ProviderOptionSelection,
  ScopedThreadRef,
} from "@threadlines/contracts";
import { ROOM_AGENT_ROLE_MAX_LENGTH, ThreadParticipantId } from "@threadlines/contracts";
import { scopedThreadKey } from "@threadlines/client-runtime";
import { activeParticipants, nextRoomAgentName } from "@threadlines/shared/threadParticipants";
import { useMemo } from "react";

import { type DraftId, type DraftRoom, useComposerDraftStore } from "~/composerDraftStore";
import { readEnvironmentApi } from "~/environmentApi";
import { newCommandId, randomUUID } from "~/lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  buildRoomAgentLabels,
  resolveRoomRecipient,
  roomAgentKey,
  roomModelName,
  useRoomRecipientStore,
} from "../../rooms";
import { changeRoomAgentModel, pickRoomAgentOptions, renameRoomAgent } from "./roomAgentActions";
import { getPickerModelName } from "./providerIconUtils";

/** One agent as the picker lists it. */
export interface RoomAgentRow {
  /** Null: the thread's own agent. */
  readonly id: ThreadParticipantId | null;
  /** "GPT-6 Astra 2 (Reviewer)". */
  readonly name: string;
  /** "GPT-6 Astra 2": what stays when the user's name is cleared. */
  readonly modelName: string;
  readonly role: string | null;
  readonly modelSelection: ModelSelection;
  readonly entry: ProviderInstanceEntry | undefined;
  readonly status: "working" | "answering" | null;
}

export interface RoomAgents {
  /** The thread's own agent first, then every added agent still in it. */
  readonly rows: ReadonlyArray<RoomAgentRow>;
  /** Another agent is in the thread besides its own. */
  readonly inRoom: boolean;
  /** Who the next message goes to. */
  readonly recipient: RoomAgentRow;
  /**
   * False while a new thread's first message is on its way: the server
   * thread takes its agents over, so the draft's can no longer change.
   */
  readonly editable: boolean;
  /** Scoped key of the thread, for "Add agent" asked for from the palette. */
  readonly threadRef: ScopedThreadRef;
  readonly choose: (id: ThreadParticipantId | null) => void;
  readonly add: (instanceId: ProviderInstanceId, model: string) => Promise<void>;
  readonly remove: (row: RoomAgentRow) => Promise<void>;
  /** An empty name clears it. */
  readonly rename: (row: RoomAgentRow, typed: string) => Promise<void>;
  readonly changeModel: (
    row: RoomAgentRow,
    instanceId: ProviderInstanceId,
    model: string,
  ) => Promise<void>;
  /** Reasoning and the like for an added agent. */
  readonly pickOptions: (
    id: ThreadParticipantId,
    options: ReadonlyArray<ProviderOptionSelection>,
  ) => void;
}

interface RoomThreadInput {
  readonly participants?: ReadonlyArray<OrchestrationThreadParticipant> | undefined;
  readonly agentRole?: string | undefined;
  readonly session?: { readonly participantId?: ThreadParticipantId | null | undefined } | null;
}

const pickerName = (model: ProviderInstanceEntry["models"][number], entry: ProviderInstanceEntry) =>
  getPickerModelName(model, entry.driverKind);

const dispatchToServer = async (
  threadRef: ScopedThreadRef,
  command: ClientOrchestrationCommand,
) => {
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) {
    throw new Error("This computer is not connected.");
  }
  await api.orchestration.dispatchCommand(command);
};

export function useRoomAgents(input: {
  readonly threadRef: ScopedThreadRef;
  /** Set for a new thread: its agents live in this draft until it is sent. */
  readonly draftTarget: ScopedThreadRef | DraftId | null;
  readonly thread: RoomThreadInput;
  /** The thread's own agent's model: the one its next message will use. */
  readonly primaryModelSelection: ModelSelection;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** The agent with a turn in flight, if any. */
  readonly workingId: ThreadParticipantId | null | undefined;
  /** The agent answering on the side, if any. */
  readonly answeringId: ThreadParticipantId | null | undefined;
  /**
   * A new thread's first message is on its way with the agents it had: a
   * change now would miss the thread, so none is taken until it exists.
   */
  readonly frozen: boolean;
}): RoomAgents {
  const { threadRef, draftTarget, thread, primaryModelSelection, instanceEntries } = input;
  const chosen = useRoomRecipientStore((state) => state.chosen[scopedThreadKey(threadRef)]);
  const draftRoom = useComposerDraftStore((store) =>
    draftTarget === null ? undefined : (store.getDraftThread(draftTarget)?.room ?? null),
  );
  const draftPromoting = useComposerDraftStore((store) =>
    draftTarget === null ? false : (store.getDraftThread(draftTarget)?.promotedTo ?? null) !== null,
  );

  const { rows, takenNames } = useMemo(() => {
    const participants = thread.participants ?? [];
    const labels = buildRoomAgentLabels(
      { modelSelection: primaryModelSelection, participants, agentRole: thread.agentRole },
      instanceEntries,
      pickerName,
    );
    const statusOf = (id: ThreadParticipantId | null): RoomAgentRow["status"] =>
      input.workingId !== undefined && input.workingId === id
        ? "working"
        : input.answeringId !== undefined && input.answeringId === id
          ? "answering"
          : null;
    const rowFor = (id: ThreadParticipantId | null, selection: ModelSelection): RoomAgentRow => {
      const label = labels?.get(roomAgentKey(id));
      const modelName = label?.modelName ?? roomModelName(selection, instanceEntries, pickerName);
      const role = label?.role ?? (id === null ? (thread.agentRole ?? null) : null);
      return {
        id,
        name: label?.name ?? (role ? `${modelName} (${role})` : modelName),
        modelName,
        role,
        modelSelection: selection,
        entry: instanceEntries.find((entry) => entry.instanceId === selection.instanceId),
        status: statusOf(id),
      };
    };
    const listed = [
      rowFor(null, primaryModelSelection),
      ...activeParticipants({ participants }).map((participant) =>
        rowFor(participant.id, participant.modelSelection),
      ),
    ];
    // Every name an agent ever had here, guests and agents that left
    // included: the server keeps a guest's name taken.
    const taken = labels
      ? [...labels.entries()].map(([key, label]) => ({ key, modelName: label.modelName }))
      : listed.map((row) => ({ key: roomAgentKey(row.id), modelName: row.modelName }));
    return { rows: listed, takenNames: taken };
  }, [
    input.answeringId,
    input.workingId,
    instanceEntries,
    primaryModelSelection,
    thread.agentRole,
    thread.participants,
  ]);

  const recipientId = resolveRoomRecipient(thread, chosen);
  const recipient = rows.find((row) => row.id === recipientId) ?? rows[0]!;
  const choose = (id: ThreadParticipantId | null) =>
    useRoomRecipientStore.getState().choose(threadRef, id);
  /** The name a new or moved agent gets: its model's, numbered past the others. */
  const nameOnModel = (selection: ModelSelection, except: ThreadParticipantId | null | undefined) =>
    nextRoomAgentName(
      roomModelName(selection, instanceEntries, pickerName),
      takenNames
        .filter((taken) => except === undefined || taken.key !== roomAgentKey(except))
        .map((taken) => taken.modelName),
    );
  const editable = !input.frozen && !draftPromoting;

  const writeDraftRoom = (next: (room: DraftRoom) => DraftRoom) => {
    if (draftTarget === null) return;
    useComposerDraftStore.getState().setDraftRoom(draftTarget, next(draftRoom ?? { agents: [] }));
  };

  const add = async (instanceId: ProviderInstanceId, model: string) => {
    if (!editable) return;
    const modelSelection = { instanceId, model };
    const handle = nameOnModel(modelSelection, undefined);
    const id = ThreadParticipantId.make(randomUUID());
    if (draftTarget !== null) {
      writeDraftRoom((room) => ({
        ...room,
        agents: [...room.agents, { id, handle, modelSelection }],
      }));
      choose(id);
      return;
    }
    await dispatchToServer(threadRef, {
      type: "thread.participant.add",
      commandId: newCommandId(),
      threadId: threadRef.threadId,
      participant: { id, handle, modelSelection },
      createdAt: new Date().toISOString(),
    });
    choose(id);
  };

  const remove = async (row: RoomAgentRow) => {
    if (row.id === null || !editable) return;
    const id = row.id;
    if (draftTarget !== null) {
      writeDraftRoom((room) => ({
        ...room,
        agents: room.agents.filter((agent) => agent.id !== id),
      }));
    } else {
      await dispatchToServer(threadRef, {
        type: "thread.participant.remove",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
        participantId: id,
        createdAt: new Date().toISOString(),
      });
    }
    if (recipient.id === id) {
      choose(null);
    }
  };

  const rename = async (row: RoomAgentRow, typed: string) => {
    const role = typed.trim().slice(0, ROOM_AGENT_ROLE_MAX_LENGTH) || null;
    if (role === row.role || !editable) return;
    if (draftTarget === null) {
      await renameRoomAgent(threadRef, row.id, role);
      return;
    }
    writeDraftRoom((room) => {
      if (row.id === null) {
        const { agentRole: _previous, ...rest } = room;
        return role === null ? rest : { ...rest, agentRole: role };
      }
      return {
        ...room,
        agents: room.agents.map((agent) => {
          if (agent.id !== row.id) return agent;
          const { role: _previous, ...rest } = agent;
          return role === null ? rest : { ...rest, role };
        }),
      };
    });
  };

  const changeModel = async (row: RoomAgentRow, instanceId: ProviderInstanceId, model: string) => {
    if (
      row.id === null ||
      !editable ||
      (instanceId === row.modelSelection.instanceId && model === row.modelSelection.model)
    ) {
      return;
    }
    const modelSelection = { instanceId, model };
    // Named like a newly added agent on that model, numbered past the others.
    const handle = nameOnModel(modelSelection, row.id);
    if (draftTarget === null) {
      await changeRoomAgentModel(threadRef, row.id, modelSelection, handle);
      return;
    }
    writeDraftRoom((room) => ({
      ...room,
      agents: room.agents.map((agent) =>
        agent.id === row.id ? { ...agent, handle, modelSelection } : agent,
      ),
    }));
  };

  const pickOptions = (
    id: ThreadParticipantId,
    options: ReadonlyArray<ProviderOptionSelection>,
  ) => {
    if (!editable) return;
    if (draftTarget === null) {
      pickRoomAgentOptions(threadRef, id, options);
      return;
    }
    // A new thread's agents carry their options into the thread with them.
    writeDraftRoom((room) => ({
      ...room,
      agents: room.agents.map((agent) =>
        agent.id === id
          ? { ...agent, modelSelection: { ...agent.modelSelection, options: [...options] } }
          : agent,
      ),
    }));
  };

  return {
    rows,
    inRoom: rows.length > 1,
    recipient,
    editable,
    threadRef,
    choose,
    add,
    remove,
    rename,
    changeModel,
    pickOptions,
  };
}
