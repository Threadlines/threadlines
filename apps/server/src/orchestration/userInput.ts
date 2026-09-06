import { UserInputRequestedPayload, type ProviderUserInputAnswers } from "@threadlines/contracts";
import * as Schema from "effect/Schema";

const decodeRequestedInput = Schema.decodeUnknownOption(UserInputRequestedPayload);

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
