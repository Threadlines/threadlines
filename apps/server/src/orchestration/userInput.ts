import {
  ApprovalRequestId,
  EventId,
  MessageId,
  UserInputRequestedPayload,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProviderUserInputAnswers,
  type ThreadParticipantId,
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
