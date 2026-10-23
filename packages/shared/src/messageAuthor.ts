/**
 * Who wrote a message, as an agent reading a thread is told.
 *
 * A user-role message is not always the user's: in a room another agent can
 * write one (a request, a routed reply), with child threads another thread's
 * agent can (a parent's request into its child, a child's report into its
 * parent), and so can an agent running outside Threadlines (an outside
 * agent's start or send). An agent that took those for the user would obey
 * them as the user's instructions. `room_history` and `thread_read` both
 * label through this one function, and transcripts handed to an agent
 * (context seeds, a fork's context) through `transcriptAuthor`, so none of
 * them can call an agent's message the user's.
 */
import type { OrchestrationMessage, ThreadId, ThreadParticipantId } from "@threadlines/contracts";
import { isAgentOrigin } from "./roomAgentRequests.ts";

/**
 * `user`: the user wrote it, or an outside agent did (named in the author:
 * linked computers on older versions know no other word). `agent`: an agent
 * in the thread did, itself or on request. `thread_request` /
 * `thread_report`: another thread's agent did (a parent's request, a
 * child's report).
 */
export type MessageOrigin = "user" | "agent" | "thread_request" | "thread_report";

export interface MessageAuthorNames {
  /** An agent of the thread being read, by participant (null: its own agent). */
  readonly agentName: (participantId: ThreadParticipantId | null | undefined) => string;
  /** Another thread's title, when it is known. */
  readonly threadTitle: (threadId: ThreadId) => string | undefined;
}

const quotedThread = (names: MessageAuthorNames, threadId: ThreadId) => {
  const title = names.threadTitle(threadId);
  return title !== undefined ? `thread "${title}" (${threadId})` : `thread ${threadId}`;
};

/** How an outside agent is named in history: "Claude Code (outside agent)". */
export const outsideAgentAuthor = (agent: { readonly name: string }): string =>
  `${agent.name} (outside agent)`;

/**
 * The name a transcript handed to an agent gives a message instead of its
 * role's ("User"), or undefined to keep the role's: an outside agent's
 * message carries the agent's name.
 */
export function transcriptAuthor(
  message: Pick<OrchestrationMessage, "role" | "fromOutside">,
): string | undefined {
  return message.role === "user" && message.fromOutside !== undefined
    ? outsideAgentAuthor(message.fromOutside)
    : undefined;
}

/** The message's author line and origin. */
export function messageAuthor(
  message: Pick<
    OrchestrationMessage,
    "role" | "participantId" | "fromAgent" | "fromThread" | "fromOutside"
  >,
  names: MessageAuthorNames,
): { readonly author: string; readonly origin: MessageOrigin } {
  if (message.role !== "user") {
    return { author: names.agentName(message.participantId), origin: "agent" };
  }
  const outside = transcriptAuthor(message);
  if (outside !== undefined) {
    return { author: outside, origin: "user" };
  }
  if (message.fromThread !== undefined) {
    return message.fromThread.kind === "request"
      ? {
          author: `Request from ${quotedThread(names, message.fromThread.threadId)}`,
          origin: "thread_request",
        }
      : {
          author: `Report from ${quotedThread(names, message.fromThread.threadId)}`,
          origin: "thread_report",
        };
  }
  if (isAgentOrigin(message)) {
    return { author: names.agentName(message.fromAgent?.participantId), origin: "agent" };
  }
  return { author: "User", origin: "user" };
}
