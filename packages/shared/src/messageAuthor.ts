/**
 * Who wrote a message, as an agent reading a thread is told.
 *
 * A user-role message is not always the user's: in a room another agent can
 * write one (a request, a routed reply), and with child threads another
 * thread's agent can (a parent's request into its child, a child's report
 * into its parent). An agent that took those for the user would obey them
 * as the user's instructions. `room_history` and `thread_read` both label
 * through this one function, so neither can call an agent's message the
 * user's.
 */
import type { OrchestrationMessage, ThreadId, ThreadParticipantId } from "@threadlines/contracts";
import { isAgentOrigin } from "./roomAgentRequests.ts";

/**
 * `user`: the user wrote it. `agent`: an agent in the thread did, itself or
 * on request. `thread_request` / `thread_report`: another thread's agent
 * did (a parent's request, a child's report).
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

/** The message's author line and origin. */
export function messageAuthor(
  message: Pick<OrchestrationMessage, "role" | "participantId" | "fromAgent" | "fromThread">,
  names: MessageAuthorNames,
): { readonly author: string; readonly origin: MessageOrigin } {
  if (message.role !== "user") {
    return { author: names.agentName(message.participantId), origin: "agent" };
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
