/**
 * The agents in a room, as the room tools name them.
 *
 * Every agent is named the way the room shows it: its model's name, numbered
 * for repeats ("GPT-6 Astra 2"), with the user's name for it after
 * ("GPT-6 Astra 2 (Reviewer)"). An added agent's numbered name is stored as
 * its handle when it joins; the thread's own agent is named by its model.
 *
 * A model asking for an agent gets to use whichever of those it has seen: the
 * participant id, the key, the full name, the handle, the user's name for it,
 * or its model. Matching ignores case and anything but letters and digits, so
 * "gpt-6 astra 2" finds "GPT-6 Astra 2". A name that fits two agents is
 * refused with both listed, never guessed.
 */
import type {
  ModelSelection,
  OrchestrationThreadParticipant,
  ThreadParticipantId,
} from "@threadlines/contracts";

/** The thread's own agent's key, as room tools report it. */
export const PRIMARY_AGENT_KEY = "primary";

export interface RoomAgentEntry {
  /** `primary` or the participant id. */
  readonly key: string;
  /** Null: the thread's own agent. */
  readonly participantId: ThreadParticipantId | null;
  /** "GPT-6 Astra 2 (Reviewer)". */
  readonly name: string;
  /** "GPT-6 Astra 2": the model's name, numbered for repeats. */
  readonly modelName: string;
  /** The user's name for it (RoomAgentRole). */
  readonly role: string | null;
  readonly modelSelection: ModelSelection;
  /** Still in the room. The thread's own agent always is. */
  readonly present: boolean;
}

export interface RoomAgentThread {
  readonly modelSelection: ModelSelection;
  readonly agentRole?: string | undefined;
  readonly participants: ReadonlyArray<OrchestrationThreadParticipant>;
}

const displayName = (modelName: string, role: string | null) =>
  role !== null ? `${modelName} (${role})` : modelName;

/**
 * Every agent that ever took part, the thread's own first, so earlier
 * messages keep an author after an agent leaves. `primaryModelName` is the
 * thread's own model as the model picker names it.
 */
export function roomAgentEntries(
  thread: RoomAgentThread,
  primaryModelName: string,
): ReadonlyArray<RoomAgentEntry> {
  const primaryRole = thread.agentRole ?? null;
  return [
    {
      key: PRIMARY_AGENT_KEY,
      participantId: null,
      name: displayName(primaryModelName, primaryRole),
      modelName: primaryModelName,
      role: primaryRole,
      modelSelection: thread.modelSelection,
      present: true,
    },
    ...thread.participants.map((participant) => ({
      key: participant.id,
      participantId: participant.id,
      name: displayName(participant.handle, participant.role ?? null),
      modelName: participant.handle,
      role: participant.role ?? null,
      modelSelection: participant.modelSelection,
      present: participant.leftAt === null,
    })),
  ];
}

/** The entry for an agent, or a stand-in for one this thread never had. */
export function roomAgentEntryFor(
  entries: ReadonlyArray<RoomAgentEntry>,
  participantId: ThreadParticipantId | null | undefined,
): RoomAgentEntry | undefined {
  return entries.find((entry) => entry.participantId === (participantId ?? null));
}

/** An agent's name, for labels. */
export function roomAgentName(
  entries: ReadonlyArray<RoomAgentEntry>,
  participantId: ThreadParticipantId | null | undefined,
): string {
  return roomAgentEntryFor(entries, participantId)?.name ?? "an agent that has left";
}

/** Case and anything but letters and digits ignored. */
export const normalizeAgentName = (value: string): string =>
  value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export type RoomAgentResolution =
  | { readonly kind: "found"; readonly entry: RoomAgentEntry }
  | { readonly kind: "unknown" | "ambiguous"; readonly detail: string };

/**
 * The agent a tool input names, among agents still in the room. An id or key
 * wins outright; otherwise a name must fit exactly one agent.
 */
export function resolveRoomAgent(
  entries: ReadonlyArray<RoomAgentEntry>,
  input: string,
): RoomAgentResolution {
  const present = entries.filter((entry) => entry.present);
  const listed = present.map((entry) => `${entry.name} (${entry.key})`).join(", ");
  const trimmed = input.trim();
  const byKey = present.find((entry) => entry.key.toLowerCase() === trimmed.toLowerCase());
  if (byKey !== undefined) {
    return { kind: "found", entry: byKey };
  }
  const wanted = normalizeAgentName(trimmed);
  if (wanted.length === 0) {
    return { kind: "unknown", detail: `Name an agent. Agents in this room: ${listed}.` };
  }
  const matches = present.filter((entry) =>
    [entry.name, entry.modelName, entry.role, entry.modelSelection.model].some(
      (candidate) => candidate !== null && normalizeAgentName(candidate) === wanted,
    ),
  );
  if (matches.length === 1) {
    return { kind: "found", entry: matches[0]! };
  }
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      detail: `"${trimmed}" fits more than one agent: ${matches
        .map((entry) => `${entry.name} (${entry.key})`)
        .join(", ")}. Use the key.`,
    };
  }
  return {
    kind: "unknown",
    detail: `No agent in this room is called "${trimmed}". Agents in this room: ${listed}.`,
  };
}
