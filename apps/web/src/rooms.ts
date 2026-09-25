/**
 * Client rules for rooms: threads with more than one agent.
 *
 * The thread's own agent is addressed with a null participant id; agents added
 * later have a handle the user types after `@`. Which agent the composer
 * addresses is remembered per thread in memory and defaults to the agent that
 * worked last, so the common case of carrying on with the same agent stays one
 * keystroke.
 */
import { scopedThreadKey } from "@threadlines/client-runtime";
import type {
  ModelSelection,
  OrchestrationThreadParticipant,
  ProviderOptionSelection,
  ScopedThreadRef,
  ThreadParticipantId,
} from "@threadlines/contracts";
import {
  activeParticipants,
  findActiveParticipantByHandle,
} from "@threadlines/shared/threadParticipants";
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

/** The agent named by a message that starts with `@handle`, if any. */
export function parseLeadingRoomMention(
  text: string,
  thread: RoomThreadLike,
): OrchestrationThreadParticipant | null {
  const match = /^\s*@([\w.-]+)(?=\s|$)/.exec(text);
  if (!match?.[1]) {
    return null;
  }
  return findActiveParticipantByHandle(participantsOf(thread), match[1]) ?? null;
}

const VENDOR_WORDS = new Set(["gpt", "claude", "codex", "openai", "anthropic", "cursor"]);

/**
 * A short handle for a new agent from its model's display name: the first
 * plain word that is not a vendor name ("GPT-6 Astra" → "astra", "Claude
 * Opus 5" → "opus"). Taken handles get the provider appended, then a number.
 */
export function suggestParticipantHandle(input: {
  readonly modelDisplayName: string;
  readonly model: string;
  readonly providerName: string;
  readonly taken: ReadonlyArray<string>;
}): string {
  const words = input.modelDisplayName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  const base =
    words.find((word) => /^[a-z]+$/.test(word) && !VENDOR_WORDS.has(word)) ??
    input.model.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const taken = new Set(input.taken.map((handle) => handle.toLowerCase()));
  if (!taken.has(base)) {
    return base;
  }
  const withProvider = `${base}-${input.providerName.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
  if (!taken.has(withProvider)) {
    return withProvider;
  }
  let index = 2;
  while (taken.has(`${withProvider}-${index}`)) {
    index += 1;
  }
  return `${withProvider}-${index}`;
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

/** How an agent is shown in a room: its name, the model it runs, and its provider. */
export interface RoomAgentLabel {
  readonly name: string;
  readonly model: string;
  readonly entry: ProviderInstanceEntry | undefined;
}

/** Map key for an agent; the thread's own agent has no participant id. */
export const roomAgentKey = (participantId: ThreadParticipantId | null | undefined): string =>
  participantId ?? "primary";

/**
 * Labels for every agent that ever took part in a room, including ones that
 * left, so their earlier messages keep an author. Null outside rooms.
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
  const label = (selection: ModelSelection, name?: string): RoomAgentLabel => {
    const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
    const model = entry?.models.find((candidate) => candidate.slug === selection.model);
    return {
      name: name ?? (model && entry ? modelDisplayName(model, entry) : selection.model),
      model: selection.model,
      entry,
    };
  };
  const labels = new Map<string, RoomAgentLabel>([
    [roomAgentKey(null), label(thread.modelSelection)],
  ]);
  for (const participant of thread.participants ?? []) {
    labels.set(
      roomAgentKey(participant.id),
      label(participant.modelSelection, `@${participant.handle}`),
    );
  }
  return labels;
}

/**
 * The name the inbox gives the agent holding a room's session slot: its
 * handle, or a short name from the thread's own model ("claude-fable-5-1" →
 * "fable"). Null outside rooms, where the row just says "working".
 */
export function roomSlotAgentName(
  thread: RoomThreadLike & { readonly modelSelection: ModelSelection },
): string | null {
  if (!isRoom(thread)) {
    return null;
  }
  const holderId = thread.session?.participantId ?? null;
  const holder =
    holderId === null ? undefined : thread.participants?.find((entry) => entry.id === holderId);
  if (holder) {
    return holder.handle;
  }
  const model = thread.modelSelection.model;
  return suggestParticipantHandle({ modelDisplayName: model, model, providerName: "", taken: [] });
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
 * Who a send goes to in a room, and the model it runs with. A message that
 * starts with `@name` picks the agent; otherwise the composer's choice, which
 * defaults to the agent that worked last. Null recipient: the thread's own
 * agent, whose model the composer controls. Every send path uses this, so a
 * plan follow-up and a typed message route the same way.
 */
export function resolveRoomSend(input: {
  readonly enabled: boolean;
  readonly thread: RoomThreadLike;
  readonly threadRef: ScopedThreadRef;
  readonly text: string;
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
    parseLeadingRoomMention(input.text, input.thread) ??
    (input.thread.participants ?? []).find((entry) => entry.id === chosenId) ??
    null;
  return {
    active: true,
    recipient,
    modelSelection: recipient ? roomAgentModelSelection(input.threadRef, recipient) : null,
  };
}
