/**
 * Provider session keys for agents added to a thread (a room).
 *
 * Everything below orchestration -- ProviderService, the adapters, the session
 * directory, the idle reaper -- identifies a running agent by a `ThreadId`. The
 * thread's own agent keeps the plain thread id. An added agent gets a derived
 * key, so it can run its own provider session without any of those layers
 * learning about rooms. Code that has to reach the real thread (event routing,
 * MCP credentials, checkpoint capture) maps the key back with
 * `parseParticipantSessionKey`.
 *
 * The separator is letters and underscores only: keys end up in log file names
 * and must stay valid path segments on every platform. Thread ids and agent
 * ids are both UUIDs (the decider refuses non-UUID agent ids), and a key is
 * only recognized as `<uuid>__agent__<uuid>`, so a thread id that merely
 * contains the separator is never mistaken for an agent's key.
 *
 * A side answer runs in its own short-lived runtime under a third kind of
 * key, `<thread>__side__<sideTurn>__<agent|primary>` (all UUIDs). It is a
 * disposable copy, never the agent's working session, so
 * `parseParticipantSessionKey` deliberately does not recognize it: to any
 * code that has not been taught about side answers, a side key looks like an
 * unrelated thread, and it can never be mistaken for the agent it copies.
 * Code that must route side runtimes (event mapping, their lifecycle) reads
 * them with `parseSessionKey`.
 */
import {
  type ModelSelection,
  type OrchestrationThreadParticipant,
  SideTurnId,
  ThreadId,
  ThreadParticipantId,
} from "@threadlines/contracts";

const PARTICIPANT_KEY_SEPARATOR = "__agent__";
const SIDE_KEY_SEPARATOR = "__side__";
const SIDE_PRIMARY_AGENT = "primary";
const PARTICIPANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Agent ids are UUIDs; see the module note. */
export function isValidParticipantId(id: string): boolean {
  return PARTICIPANT_ID_PATTERN.test(id);
}

export interface ParticipantSessionTarget {
  readonly threadId: ThreadId;
  /** Null for the thread's own agent. */
  readonly participantId: ThreadParticipantId | null;
}

/** The provider session key for one agent in a thread. */
export function participantSessionKey(
  threadId: ThreadId,
  participantId: ThreadParticipantId | null | undefined,
): ThreadId {
  if (participantId === null || participantId === undefined) {
    return threadId;
  }
  return ThreadId.make(`${threadId}${PARTICIPANT_KEY_SEPARATOR}${participantId}`);
}

/** Map a provider session key back to its thread and agent. */
export function parseParticipantSessionKey(key: ThreadId): ParticipantSessionTarget {
  const index = key.lastIndexOf(PARTICIPANT_KEY_SEPARATOR);
  if (index <= 0) {
    return { threadId: key, participantId: null };
  }
  const participant = key.slice(index + PARTICIPANT_KEY_SEPARATOR.length);
  const thread = key.slice(0, index);
  if (!isValidParticipantId(participant) || !PARTICIPANT_ID_PATTERN.test(thread)) {
    return { threadId: key, participantId: null };
  }
  return {
    threadId: ThreadId.make(thread),
    participantId: ThreadParticipantId.make(participant),
  };
}

/** The thread a provider session key belongs to. A side key maps to itself. */
export function sessionKeyThreadId(key: ThreadId): ThreadId {
  return parseParticipantSessionKey(key).threadId;
}

/** The provider session key for one side answer's runtime. */
export function sideSessionKey(
  threadId: ThreadId,
  sideTurnId: SideTurnId,
  participantId: ThreadParticipantId | null,
): ThreadId {
  return ThreadId.make(
    `${threadId}${SIDE_KEY_SEPARATOR}${sideTurnId}__${participantId ?? SIDE_PRIMARY_AGENT}`,
  );
}

export type SessionKeyTarget =
  | ({ readonly kind: "main" } & ParticipantSessionTarget)
  | ({ readonly kind: "side"; readonly sideTurnId: SideTurnId } & ParticipantSessionTarget);

/**
 * Map any provider session key back to its thread and agent, telling an
 * agent's working session (`main`) from a side answer's runtime (`side`).
 */
export function parseSessionKey(key: ThreadId): SessionKeyTarget {
  const side = parseSideSessionKey(key);
  return side ?? { kind: "main", ...parseParticipantSessionKey(key) };
}

function parseSideSessionKey(key: ThreadId): SessionKeyTarget | null {
  const index = key.indexOf(SIDE_KEY_SEPARATOR);
  if (index <= 0) {
    return null;
  }
  const thread = key.slice(0, index);
  const [sideTurn, agent, ...rest] = key.slice(index + SIDE_KEY_SEPARATOR.length).split("__");
  if (
    rest.length > 0 ||
    sideTurn === undefined ||
    agent === undefined ||
    !PARTICIPANT_ID_PATTERN.test(thread) ||
    !PARTICIPANT_ID_PATTERN.test(sideTurn) ||
    (agent !== SIDE_PRIMARY_AGENT && !isValidParticipantId(agent))
  ) {
    return null;
  }
  return {
    kind: "side",
    threadId: ThreadId.make(thread),
    sideTurnId: SideTurnId.make(sideTurn),
    participantId: agent === SIDE_PRIMARY_AGENT ? null : ThreadParticipantId.make(agent),
  };
}

interface ParticipantListHolder {
  readonly participants: ReadonlyArray<OrchestrationThreadParticipant>;
}

/**
 * A thread becomes a room once an agent is added, and stays one after it
 * leaves. A guest (an invited one-off reviewer) never makes it one.
 */
export function isRoomThread(thread: ParticipantListHolder): boolean {
  return thread.participants.some((participant) => participant.guest !== true);
}

/**
 * Whether any other agent ever took part, guests included: what author
 * labels, Stop and restart recovery of agent requests go by.
 */
export function hasAgentRecords(thread: ParticipantListHolder): boolean {
  return thread.participants.length > 0;
}

/** Agents currently in the thread, besides its own agent. Guests never are. */
export function activeParticipants(
  thread: ParticipantListHolder,
): ReadonlyArray<OrchestrationThreadParticipant> {
  return thread.participants.filter((participant) => participant.leftAt === null);
}

/**
 * The name for an agent joining a room: its model's name, numbered when an
 * agent with that name is already here ("GPT-6 Astra 2"). The web's room
 * labels apply the same rule, so the stored name and the shown one agree.
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

/**
 * Case-insensitive handle lookup among agents currently in the thread, and
 * guests: a guest keeps its name for when the user adds it to the thread.
 */
export function findActiveParticipantByHandle(
  thread: ParticipantListHolder,
  handle: string,
): OrchestrationThreadParticipant | undefined {
  const wanted = handle.trim().toLowerCase();
  return thread.participants.find(
    (participant) =>
      (participant.leftAt === null || participant.guest === true) &&
      participant.handle.toLowerCase() === wanted,
  );
}

/**
 * Key for one agent in per-agent records (`roomContext`, `sentModels`, a
 * message's `agentModels`): its participant id, or `primary` for the thread's
 * own agent.
 */
export const roomAgentKey = (participantId: ThreadParticipantId | null | undefined): string =>
  participantId ?? "primary";

/**
 * `sentModels` after a turn is asked of an agent: the model asked for, else
 * the one its turns were last sent with, else its own setting. The reactor
 * sends the turn with what is recorded here, and the turn's messages are
 * stamped with it. The in-memory projector and the SQL projection both use
 * this, so they agree.
 */
export function recordTurnModel(
  room: {
    readonly modelSelection: ModelSelection;
    readonly participants: ReadonlyArray<OrchestrationThreadParticipant>;
    readonly sentModels?: Readonly<Record<string, ModelSelection>> | undefined;
  },
  participantId: ThreadParticipantId | null,
  requested: ModelSelection | undefined,
): Record<string, ModelSelection> {
  const key = roomAgentKey(participantId);
  const own =
    participantId === null
      ? undefined
      : room.participants.find((entry) => entry.id === participantId)?.modelSelection;
  return {
    ...room.sentModels,
    [key]: requested ?? room.sentModels?.[key] ?? own ?? room.modelSelection,
  };
}

/** The agent holding the thread's session slot. Null: the thread's own agent. */
export function sessionSlotParticipantId(
  session: { readonly participantId?: ThreadParticipantId | null | undefined } | null,
): ThreadParticipantId | null {
  return session?.participantId ?? null;
}

const joinedGuest = (entry: OrchestrationThreadParticipant): OrchestrationThreadParticipant => {
  const { guest: _guest, ...member } = entry;
  return { ...member, leftAt: null };
};

/**
 * Apply a `thread.participant-updated` event to a room's agents: a name for
 * any of them (null clears it), new model options for an added one. The
 * in-memory projector and the SQL projection both use this, so they agree.
 */
export function applyRoomAgentUpdate(
  room: {
    readonly participants: ReadonlyArray<OrchestrationThreadParticipant>;
    readonly agentRole?: string | undefined;
  },
  update: {
    readonly participantId: ThreadParticipantId | null;
    readonly role?: string | null | undefined;
    readonly modelSelection?: ModelSelection | undefined;
    /** The agent's name for its new model, with a model change. */
    readonly handle?: string | undefined;
    /** A guest joins the thread as a member. */
    readonly joined?: true | undefined;
  },
): {
  readonly participants: OrchestrationThreadParticipant[];
  readonly agentRole: string | undefined;
} {
  const withRole = <T extends { readonly role?: string | undefined }>(entry: T): T => {
    if (update.role === undefined) return entry;
    const { role: _previous, ...rest } = entry;
    return (update.role === null ? rest : { ...rest, role: update.role }) as T;
  };
  if (update.participantId === null) {
    return {
      participants: [...room.participants],
      agentRole: update.role === undefined ? room.agentRole : (update.role ?? undefined),
    };
  }
  return {
    participants: room.participants.map((entry) =>
      entry.id !== update.participantId
        ? entry
        : {
            ...withRole(update.joined === true ? joinedGuest(entry) : entry),
            ...(update.modelSelection !== undefined
              ? { modelSelection: update.modelSelection }
              : {}),
            ...(update.handle !== undefined ? { handle: update.handle } : {}),
          },
    ),
    agentRole: room.agentRole,
  };
}
