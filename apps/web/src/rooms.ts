/**
 * Client rules for rooms: threads with more than one agent.
 *
 * The thread's own agent is addressed with a null participant id. Every agent
 * is named by its model, the short name the model picker shows ("Opus 5.5",
 * "GPT-6 Astra"). The composer's agent picker says who a message goes to; the
 * choice is remembered per thread in memory and defaults to the agent that
 * worked last, so carrying on with the same agent stays one keystroke.
 */
import { scopedThreadKey } from "@threadlines/client-runtime";
import type {
  ModelSelection,
  OrchestrationThreadParticipant,
  ProviderOptionSelection,
  ScopedThreadRef,
  ThreadParticipantId,
} from "@threadlines/contracts";
import { activeParticipants } from "@threadlines/shared/threadParticipants";
import { create } from "zustand";

import type { ProviderInstanceEntry } from "./providerInstances";

interface RoomThreadLike {
  readonly participants?: ReadonlyArray<OrchestrationThreadParticipant> | undefined;
  readonly session?: { readonly participantId?: ThreadParticipantId | null | undefined } | null;
}

const participantsOf = (thread: RoomThreadLike) => ({ participants: thread.participants ?? [] });

/** True once an agent has been added to the thread. */
export function isRoom(thread: RoomThreadLike | null | undefined): boolean {
  return (thread?.participants?.length ?? 0) > 0;
}

/**
 * The agent the composer sends to: the user's explicit choice while that
 * agent is still in the thread, otherwise the agent that worked last.
 */
export function resolveRoomRecipient(
  thread: RoomThreadLike,
  chosen: ThreadParticipantId | null | undefined,
): ThreadParticipantId | null {
  const present = new Set(activeParticipants(participantsOf(thread)).map((entry) => entry.id));
  if (chosen !== undefined) {
    return chosen === null || present.has(chosen) ? chosen : null;
  }
  const holder = thread.session?.participantId ?? null;
  return holder !== null && present.has(holder) ? holder : null;
}

/**
 * The name for an agent joining a room: its model's name, numbered when an
 * agent with that name is already here ("GPT-6 Astra 2"). The same rule
 * `buildRoomAgentLabels` applies, so the stored name and the shown one agree.
 */
export function nextRoomAgentName(modelName: string, taken: ReadonlyArray<string>): string {
  const takenLower = new Set(taken.map((name) => name.toLowerCase()));
  if (!takenLower.has(modelName.toLowerCase())) {
    return modelName;
  }
  let index = 2;
  while (takenLower.has(`${modelName} ${index}`.toLowerCase())) {
    index += 1;
  }
  return `${modelName} ${index}`;
}

interface RoomRecipientState {
  /** Explicit choices by scoped thread key; absent means "follow the slot holder". */
  readonly chosen: Readonly<Record<string, ThreadParticipantId | null>>;
  readonly choose: (threadRef: ScopedThreadRef, participantId: ThreadParticipantId | null) => void;
  /**
   * Model options (reasoning and the like) picked for an added agent and not
   * sent yet, by `roomAgentOptionsKey`. The next turn for that agent carries
   * them, and the server keeps them on the agent from then on.
   */
  readonly agentOptions: Readonly<Record<string, ReadonlyArray<ProviderOptionSelection>>>;
  readonly setAgentOptions: (
    threadRef: ScopedThreadRef,
    participantId: ThreadParticipantId,
    options: ReadonlyArray<ProviderOptionSelection> | undefined,
  ) => void;
}

const roomAgentOptionsKey = (threadRef: ScopedThreadRef, participantId: ThreadParticipantId) =>
  `${scopedThreadKey(threadRef)}:${participantId}`;

/** In memory only: a reload falls back to the agent that worked last. */
export const useRoomRecipientStore = create<RoomRecipientState>((set) => ({
  chosen: {},
  choose: (threadRef, participantId) =>
    set((state) => ({
      chosen: { ...state.chosen, [scopedThreadKey(threadRef)]: participantId },
    })),
  agentOptions: {},
  setAgentOptions: (threadRef, participantId, options) =>
    set((state) => {
      const key = roomAgentOptionsKey(threadRef, participantId);
      const { [key]: _previous, ...rest } = state.agentOptions;
      return { agentOptions: options === undefined ? rest : { ...rest, [key]: options } };
    }),
}));

/**
 * The model selection a turn for an added agent runs with: the one it joined
 * with, plus any options picked since and not sent yet.
 */
export function roomAgentModelSelection(
  threadRef: ScopedThreadRef,
  participant: OrchestrationThreadParticipant,
  pendingOptions?: ReadonlyArray<ProviderOptionSelection>,
): ModelSelection {
  const options =
    pendingOptions ??
    useRoomRecipientStore.getState().agentOptions[roomAgentOptionsKey(threadRef, participant.id)];
  return options === undefined
    ? participant.modelSelection
    : { ...participant.modelSelection, options: [...options] };
}

export function useRoomAgentOptions(
  threadRef: ScopedThreadRef,
  participantId: ThreadParticipantId | null,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  return useRoomRecipientStore((state) =>
    participantId === null
      ? undefined
      : state.agentOptions[roomAgentOptionsKey(threadRef, participantId)],
  );
}

export function chosenRoomRecipient(
  threadRef: ScopedThreadRef,
): ThreadParticipantId | null | undefined {
  return useRoomRecipientStore.getState().chosen[scopedThreadKey(threadRef)];
}

/** How an agent is shown in a room: its name and its provider. */
export interface RoomAgentLabel {
  readonly name: string;
  readonly entry: ProviderInstanceEntry | undefined;
}

/** Map key for an agent; the thread's own agent has no participant id. */
export const roomAgentKey = (participantId: ThreadParticipantId | null | undefined): string =>
  participantId ?? "primary";

/**
 * Labels for every agent that ever took part in a room, including ones that
 * left, so their earlier messages keep a name. Each is named by its model;
 * agents on the same model are numbered in the order they joined, the
 * thread's own agent first. Null outside rooms.
 */
export function buildRoomAgentLabels(
  thread: RoomThreadLike & { readonly modelSelection: ModelSelection },
  entries: ReadonlyArray<ProviderInstanceEntry>,
  /** The name the model picker shows, so the two always match. */
  modelDisplayName: (
    model: ProviderInstanceEntry["models"][number],
    entry: ProviderInstanceEntry,
  ) => string,
): ReadonlyMap<string, RoomAgentLabel> | null {
  if (!isRoom(thread)) {
    return null;
  }
  const agents = [
    { key: roomAgentKey(null), selection: thread.modelSelection },
    ...(thread.participants ?? []).map((participant) => ({
      key: roomAgentKey(participant.id),
      selection: participant.modelSelection,
    })),
  ];
  const labels = new Map<string, RoomAgentLabel>();
  const named: string[] = [];
  for (const agent of agents) {
    const name = nextRoomAgentName(
      roomModelName(agent.selection, entries, modelDisplayName),
      named,
    );
    named.push(name);
    labels.set(agent.key, {
      name,
      entry: entries.find((candidate) => candidate.instanceId === agent.selection.instanceId),
    });
  }
  return labels;
}

/** A model's name as the model picker shows it, or its id when unknown here. */
export function roomModelName(
  selection: ModelSelection,
  entries: ReadonlyArray<ProviderInstanceEntry>,
  modelDisplayName: (
    model: ProviderInstanceEntry["models"][number],
    entry: ProviderInstanceEntry,
  ) => string,
): string {
  const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = entry?.models.find((candidate) => candidate.slug === selection.model);
  return model && entry ? modelDisplayName(model, entry) : selection.model;
}

/**
 * The model of the agent a room's inbox row names as working or last at
 * work. Null outside rooms, where the row just says "working".
 */
export function roomSlotModelSelection(
  thread: RoomThreadLike & { readonly modelSelection: ModelSelection },
): ModelSelection | null {
  if (!isRoom(thread)) {
    return null;
  }
  const holderId = thread.session?.participantId ?? null;
  const holder =
    holderId === null ? undefined : thread.participants?.find((entry) => entry.id === holderId);
  return holder?.modelSelection ?? thread.modelSelection;
}

/**
 * The thread's session while its own agent holds the slot; null while an
 * added agent does. The composer's model controls, the provider lock and
 * native review all belong to the thread's own agent, and must not read
 * another agent's runtime as if it were its own.
 */
export function ownAgentSession<
  Session extends { readonly participantId?: ThreadParticipantId | null | undefined },
>(thread: { readonly session?: Session | null | undefined } | null | undefined): Session | null {
  const session = thread?.session ?? null;
  return session !== null && (session.participantId ?? null) === null ? session : null;
}

/**
 * Who a send goes to in a room, and the model it runs with: the composer's
 * choice, which defaults to the agent that worked last. Null recipient: the
 * thread's own agent, whose model the composer controls. Every send path uses
 * this, so a plan follow-up and a typed message route the same way.
 */
export function resolveRoomSend(input: {
  readonly enabled: boolean;
  readonly thread: RoomThreadLike;
  readonly threadRef: ScopedThreadRef;
}): {
  readonly active: boolean;
  readonly recipient: OrchestrationThreadParticipant | null;
  readonly modelSelection: ModelSelection | null;
} {
  if (!input.enabled || !isRoom(input.thread)) {
    return { active: false, recipient: null, modelSelection: null };
  }
  const chosenId = resolveRoomRecipient(input.thread, chosenRoomRecipient(input.threadRef));
  const recipient =
    (input.thread.participants ?? []).find((entry) => entry.id === chosenId) ?? null;
  return {
    active: true,
    recipient,
    modelSelection: recipient ? roomAgentModelSelection(input.threadRef, recipient) : null,
  };
}
