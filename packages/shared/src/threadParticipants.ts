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

/** A thread becomes a room once an agent is added, and stays one after it leaves. */
export function isRoomThread(thread: ParticipantListHolder): boolean {
  return thread.participants.length > 0;
}

/** Agents currently in the thread, besides its own agent. */
export function activeParticipants(
  thread: ParticipantListHolder,
): ReadonlyArray<OrchestrationThreadParticipant> {
  return thread.participants.filter((participant) => participant.leftAt === null);
}

/** Case-insensitive handle lookup among agents currently in the thread. */
export function findActiveParticipantByHandle(
  thread: ParticipantListHolder,
  handle: string,
): OrchestrationThreadParticipant | undefined {
  const wanted = handle.trim().toLowerCase();
  return activeParticipants(thread).find(
    (participant) => participant.handle.toLowerCase() === wanted,
  );
}

/** The agent holding the thread's session slot. Null: the thread's own agent. */
export function sessionSlotParticipantId(
  session: { readonly participantId?: ThreadParticipantId | null | undefined } | null,
): ThreadParticipantId | null {
  return session?.participantId ?? null;
}
