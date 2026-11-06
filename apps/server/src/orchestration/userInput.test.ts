import { EventId, TurnId, type OrchestrationThreadActivity } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { composeUserInputAnswers, unansweredResponseRefusal } from "./userInput.ts";

const questions = [
  { id: "db", header: "Database", question: "Which database?", options: [], multiSelect: false },
  { id: "tests", header: "Tests", question: "Tests now?", options: [], multiSelect: false },
];
const reply = { text: "Postgres, and tests after the demo." };

const requestedActivity = (payload: Record<string, unknown>): OrchestrationThreadActivity => ({
  id: EventId.make("activity-requested"),
  tone: "info",
  kind: "user-input.requested",
  summary: "User input requested",
  payload: { requestId: "request-1", questions, ...payload },
  turnId: TurnId.make("turn-1"),
  createdAt: "2026-11-06T10:00:00.000Z",
});

describe("composeUserInputAnswers", () => {
  it("lets a chat reply answer the first question it covers, the rest pointing to it", () => {
    const composed = composeUserInputAnswers({
      requested: { questions, canLeaveUnanswered: true },
      answers: {},
      unanswered: { db: "replied_in_chat", tests: "replied_in_chat" },
      reply,
    });
    expect(composed).toEqual({
      _tag: "Composed",
      answers: {
        db: `The user answered in the chat instead of choosing:\n\n${reply.text}`,
        tests:
          "The user's chat reply, given as the answer to an earlier question, covers this one too.",
      },
      unanswered: { db: "replied_in_chat", tests: "replied_in_chat" },
    });
  });

  it("refuses what the asking agent can't be told, or a question left open", () => {
    const refusal = (input: Partial<Parameters<typeof composeUserInputAnswers>[0]>) => {
      const composed = composeUserInputAnswers({
        requested: { questions, canLeaveUnanswered: true },
        answers: { db: "Postgres" },
        unanswered: { tests: "skipped" },
        reply: undefined,
        ...input,
      });
      return composed._tag === "Invalid" ? composed.detail : undefined;
    };
    expect(refusal({})).toBeUndefined();
    // A yes/no confirmation, or a choice matched against its options.
    expect(refusal({ requested: { questions } })).toBe("These questions need an answer.");
    expect(refusal({ unanswered: {} })).toBeUndefined();
    expect(refusal({ answers: {}, unanswered: { tests: "skipped" } })).toBe(
      "Answer or skip each question.",
    );
    expect(refusal({ unanswered: { tests: "replied_in_chat" } })).toBe(
      "The chat reply is missing.",
    );
    expect(refusal({ reply })).toBe("The reply answers no question.");
  });
});

describe("unansweredResponseRefusal", () => {
  it("refuses a skip for a question already answered from another device", () => {
    const response = {
      requestId: "request-1",
      answers: {},
      unanswered: { db: "skipped" as const, tests: "skipped" as const },
    };
    const open = { activities: [requestedActivity({ canLeaveUnanswered: true })] };
    expect(unansweredResponseRefusal(open, response)).toBeUndefined();
    const answered = {
      activities: [
        ...open.activities,
        {
          ...requestedActivity({}),
          id: EventId.make("activity-resolved"),
          kind: "user-input.resolved",
          payload: { requestId: "request-1", answers: {} },
        },
      ],
    };
    expect(unansweredResponseRefusal(answered, response)).toBe(
      "These questions were already answered or closed.",
    );
  });
});
