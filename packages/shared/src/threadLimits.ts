export const MAX_THREAD_MESSAGES = 2_000;
export const MAX_THREAD_CHECKPOINTS = 500;
export const MAX_THREAD_PROPOSED_PLANS = 200;
export const MAX_THREAD_ACTIVITIES = 500;

export const MAX_THREAD_ACTIVITY_PAYLOAD_TEXT_LENGTH = 4_000;
/** Collab agent results are the agent's entire output — the chat renders them
 *  as first-class messages, so they get a far larger cap than tool payloads. */
export const MAX_THREAD_ACTIVITY_PAYLOAD_AGENT_RESULT_TEXT_LENGTH = 32_000;
export const MAX_THREAD_ACTIVITY_PAYLOAD_ARRAY_ITEMS = 50;
export const MAX_THREAD_ACTIVITY_PAYLOAD_OBJECT_KEYS = 80;
export const MAX_THREAD_ACTIVITY_PAYLOAD_DEPTH = 8;

/**
 * How often the server sends a streaming reply's new text: at most one event
 * per message this often (a reply's first words go out at once). Each one is
 * saved, projected and pushed to every client, and the chat's reveal paces
 * itself from this so the text still moves smoothly between them.
 */
export const ASSISTANT_STREAM_FLUSH_INTERVAL_MS = 100;
