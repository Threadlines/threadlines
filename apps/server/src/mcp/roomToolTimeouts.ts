/**
 * How long room tool calls wait, in one place: the room tools' own deadline
 * and the per-call timeout Codex and Claude are configured with
 * (codexAppServerArgs, codexSideAnswerHome, ClaudeAdapter). The provider's
 * timeout is the longer of the two, so the Threadlines deadline always
 * answers first.
 */
import * as Duration from "effect/Duration";

/**
 * The longest an ask's or review's call waits for its answer. One that takes
 * longer goes on, and comes back to the caller as a message instead. Long
 * enough for a careful review at high reasoning to come back in the call.
 */
export const ROOM_REQUEST_DEADLINE = Duration.minutes(25);

/** How long Codex and Claude wait on one room tool call: a minute past the deadline. */
export const ROOM_TOOL_CALL_TIMEOUT = Duration.sum(ROOM_REQUEST_DEADLINE, Duration.minutes(1));
