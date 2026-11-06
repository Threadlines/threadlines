import {
  ApprovalRequestId,
  EventId,
  MessageId,
  UserInputRequestedPayload,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProviderUserInputAnswers,
  type ThreadParticipantId,
  type UserInputChatReply,
  type UserInputUnanswered,
  type UserInputUnansweredReason,
} from "@threadlines/contracts";
import {
  collectOpenPendingRequests,
  PENDING_REQUEST_USER_MESSAGE_REASON,
  USER_INPUT_ACTIVITY_KINDS,
} from "@threadlines/shared/pendingRequests";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeRequestedInput = Schema.decodeUnknownOption(UserInputRequestedPayload);

const QUESTION_ANSWER_MESSAGE_PREFIX = "question-answer:";

/** The message an answer goes to the agent as. Stable, so a replay finds it already sent. */
export const questionAnswerMessageId = (requestId: string) =>
  MessageId.make(`${QUESTION_ANSWER_MESSAGE_PREFIX}${requestId}`);

export const isQuestionAnswerMessageId = (messageId: string) =>
  messageId.startsWith(QUESTION_ANSWER_MESSAGE_PREFIX);

/** Read durable questions so message replies survive a provider process restart. */
export const readRequestedUserInput = decodeRequestedInput;

/** What the agent reads for a question left without an answer. */
const UNANSWERED_TEXT = {
  skipped: "The user skipped this question.",
  dismissed: "The user closed the questions without answering.",
} as const;
const repliedInChatText = (reply: string) =>
  `The user answered in the chat instead of choosing:\n\n${reply}`;
const REPLIED_IN_CHAT_ELSEWHERE_TEXT =
  "The user's chat reply, given as the answer to an earlier question, covers this one too.";

/** Whether an answer holds anything the agent can read. */
function hasAnswer(answer: unknown): boolean {
  if (typeof answer === "string") return answer.trim().length > 0;
  return (
    Array.isArray(answer) &&
    answer.length > 0 &&
    answer.every((value) => typeof value === "string" && value.trim().length > 0)
  );
}

export type ComposedUserInputAnswers =
  | {
      readonly _tag: "Composed";
      /** Every question answered, the unanswered ones in words the agent reads. */
      readonly answers: ProviderUserInputAnswers;
      /** The questions that went unanswered, and how (for the provider's own record). */
      readonly unanswered: UserInputUnanswered;
    }
  | { readonly _tag: "Invalid"; readonly detail: string };

/**
 * A response that leaves questions unanswered, as answers every agent can
 * read: a skipped question says so, a closed card says so, and a chat reply
 * is the answer to the first question it covers (the rest point to it).
 * Refused unless the question was asked with `canLeaveUnanswered`, every
 * question is either answered or marked, and a chat reply comes with its text.
 */
export function composeUserInputAnswers(input: {
  readonly requested: UserInputRequestedPayload;
  readonly answers: ProviderUserInputAnswers;
  readonly unanswered: UserInputUnanswered | undefined;
  readonly reply: UserInputChatReply | undefined;
}): ComposedUserInputAnswers {
  const { requested, answers, reply } = input;
  const unanswered = input.unanswered ?? {};
  if (Object.keys(unanswered).length === 0 && reply === undefined) {
    return { _tag: "Composed", answers, unanswered: {} };
  }
  if (requested.canLeaveUnanswered !== true || requested.elicitation !== undefined) {
    return { _tag: "Invalid", detail: "These questions need an answer." };
  }
  const questionIds = new Set(requested.questions.map((question) => question.id));
  if (Object.keys(unanswered).some((id) => !questionIds.has(id))) {
    return { _tag: "Invalid", detail: "That isn't one of the questions asked." };
  }
  const repliedInChat = Object.values(unanswered).includes("replied_in_chat");
  if (repliedInChat !== (reply !== undefined)) {
    return {
      _tag: "Invalid",
      detail: repliedInChat ? "The chat reply is missing." : "The reply answers no question.",
    };
  }
  const composed: Record<string, unknown> = {};
  const marked: Record<string, UserInputUnansweredReason> = {};
  let replyPlaced = false;
  for (const question of requested.questions) {
    const reason = unanswered[question.id];
    if (reason === undefined) {
      if (!hasAnswer(answers[question.id])) {
        return { _tag: "Invalid", detail: "Answer or skip each question." };
      }
      composed[question.id] = answers[question.id];
      continue;
    }
    marked[question.id] = reason;
    if (reason === "replied_in_chat") {
      composed[question.id] =
        replyPlaced || reply === undefined
          ? REPLIED_IN_CHAT_ELSEWHERE_TEXT
          : repliedInChatText(reply.text);
      replyPlaced = true;
    } else {
      composed[question.id] = UNANSWERED_TEXT[reason];
    }
  }
  return { _tag: "Composed", answers: composed, unanswered: marked };
}

/**
 * Why a response that skips, closes or replies in chat can't go to the agent,
 * or undefined when it can. Checked against the question as it is still open
 * in `thread`, so one answered meanwhile (from another device) is refused.
 */
export function unansweredResponseRefusal(
  thread: Pick<OrchestrationThread, "activities">,
  response: {
    readonly requestId: string;
    readonly answers: ProviderUserInputAnswers;
    readonly unanswered?: UserInputUnanswered | undefined;
    readonly reply?: UserInputChatReply | undefined;
  },
): string | undefined {
  const open = collectOpenPendingRequests(thread.activities, USER_INPUT_ACTIVITY_KINDS).find(
    (request) => request.requestId === response.requestId,
  );
  const requested = open ? readRequestedUserInput(open.activity.payload) : Option.none();
  if (Option.isNone(requested)) {
    return "These questions were already answered or closed.";
  }
  const composed = composeUserInputAnswers({
    requested: requested.value,
    answers: response.answers,
    unanswered: response.unanswered,
    reply: response.reply,
  });
  return composed._tag === "Invalid" ? composed.detail : undefined;
}

/** Include each question in the reply so later answers retain their context. */
export function formatUserInputReply(
  questions: UserInputRequestedPayload["questions"],
  answers: ProviderUserInputAnswers,
): string | undefined {
  const replies: string[] = [];
  for (const question of questions) {
    const answer = answers[question.id];
    const values: ReadonlyArray<unknown> =
      typeof answer === "string" ? [answer] : Array.isArray(answer) ? answer : [];
    const text = values.flatMap((value) =>
      typeof value === "string" && value.trim() ? [value.trim()] : [],
    );
    if (text.length === 0 || text.length !== values.length) {
      return undefined;
    }
    replies.push(`${question.question}\n${text.join(", ")}`);
  }
  return replies.length > 0 ? replies.join("\n\n") : undefined;
}

/**
 * The user wrote to `agentId`: the questions it asked to be answered with a
 * message close, since the user either answered in their own words or moved
 * on, and the agent can ask again. Only those open now, all asked before the
 * message; a question another agent in the room asked stays open, and so does
 * one answered through the provider, which still waits for that answer.
 */
export function questionsClosedByUserMessage(input: {
  readonly thread: Pick<OrchestrationThread, "activities">;
  readonly agentId: ThreadParticipantId | null;
  readonly messageId: MessageId;
  readonly createdAt: string;
}): ReadonlyArray<{
  readonly requestId: ApprovalRequestId;
  readonly activity: OrchestrationThreadActivity;
}> {
  return collectOpenPendingRequests(input.thread.activities, USER_INPUT_ACTIVITY_KINDS)
    .filter(({ activity }) => {
      const question = readRequestedUserInput(activity.payload);
      return (
        Option.isSome(question) &&
        question.value.responseMode === "message" &&
        (activity.participantId ?? null) === input.agentId
      );
    })
    .map(({ requestId, activity }) => ({
      requestId: ApprovalRequestId.make(requestId),
      activity: {
        id: EventId.make(`question-closed-by-message:${input.messageId}:${requestId}`),
        tone: "info",
        kind: USER_INPUT_ACTIVITY_KINDS.resolved,
        summary: "Question closed",
        payload: { requestId, reason: PENDING_REQUEST_USER_MESSAGE_REASON },
        turnId: activity.turnId,
        ...(activity.participantId != null ? { participantId: activity.participantId } : {}),
        createdAt: input.createdAt,
      },
    }));
}
