import type {
  UserInputQuestion,
  UserInputUnanswered,
  UserInputUnansweredReason,
} from "@threadlines/contracts";

export interface PendingUserInputDraftAnswer {
  selectedOptionLabels?: string[];
  customAnswer?: string;
  /** The user skipped the question; choosing or typing an answer undoes it. */
  skipped?: boolean;
}

/** The draft of a skipped question. */
export const SKIPPED_PENDING_USER_INPUT_DRAFT: PendingUserInputDraftAnswer = { skipped: true };

/** What a question card sends: the answers, and the questions left unanswered. */
export interface PendingUserInputResponse {
  readonly answers: Record<string, string | string[]>;
  readonly unanswered: UserInputUnanswered;
}

export interface PendingUserInputProgress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  activeDraft: PendingUserInputDraftAnswer | undefined;
  selectedOptionLabels: string[];
  customAnswer: string;
  resolvedAnswer: string | string[] | null;
  usingCustomAnswer: boolean;
  answeredQuestionCount: number;
  isLastQuestion: boolean;
  isComplete: boolean;
  canAdvance: boolean;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSelectedOptionLabels(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(normalized));
}

export function resolvePendingUserInputAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | string[] | null {
  const customAnswer = normalizeDraftAnswer(draft?.customAnswer);
  if (customAnswer) {
    return customAnswer;
  }

  const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
  if (question.multiSelect) {
    return selectedOptionLabels.length > 0 ? selectedOptionLabels : null;
  }

  return selectedOptionLabels[0] ?? null;
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  const selectedOptionLabels =
    customAnswer.trim().length > 0
      ? undefined
      : normalizeSelectedOptionLabels(draft?.selectedOptionLabels);

  return {
    customAnswer,
    ...(selectedOptionLabels && selectedOptionLabels.length > 0 ? { selectedOptionLabels } : {}),
  };
}

export function togglePendingUserInputOptionSelection(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionLabel: string,
): PendingUserInputDraftAnswer {
  if (question.multiSelect) {
    const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
    const nextSelectedOptionLabels = selectedOptionLabels.includes(optionLabel)
      ? selectedOptionLabels.filter((label) => label !== optionLabel)
      : [...selectedOptionLabels, optionLabel];

    return {
      customAnswer: "",
      ...(nextSelectedOptionLabels.length > 0
        ? { selectedOptionLabels: nextSelectedOptionLabels }
        : {}),
    };
  }

  return {
    customAnswer: "",
    selectedOptionLabels: [optionLabel],
  };
}

/**
 * The response for every question: answered ones carry their answer, skipped
 * ones say so, and with `rest` (the card closed, or a chat reply) every other
 * question goes unanswered that way. Null while a question has none of these.
 */
export function buildPendingUserInputResponse(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  rest?: Exclude<UserInputUnansweredReason, "skipped">,
): PendingUserInputResponse | null {
  const answers: Record<string, string | string[]> = {};
  const unanswered: Record<string, UserInputUnansweredReason> = {};
  for (const question of questions) {
    const draft = draftAnswers[question.id];
    const answer = resolvePendingUserInputAnswer(question, draft);
    if (answer) {
      answers[question.id] = answer;
    } else if (draft?.skipped === true) {
      unanswered[question.id] = "skipped";
    } else if (rest !== undefined) {
      unanswered[question.id] = rest;
    } else {
      return null;
    }
  }
  return { answers, unanswered };
}

/**
 * The response a chat reply sends: answers and skips given on the card stay,
 * and the reply answers every other question. When the card left none open,
 * the reply answers the last question in place of its card answer.
 */
export function chatReplyResponse(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): PendingUserInputResponse | null {
  const response = buildPendingUserInputResponse(questions, draftAnswers, "replied_in_chat");
  if (!response) return null;
  if (Object.values(response.unanswered).includes("replied_in_chat")) return response;
  const last = questions.at(-1);
  if (!last) return null;
  const { [last.id]: _replaced, ...answers } = response.answers;
  return { answers, unanswered: { ...response.unanswered, [last.id]: "replied_in_chat" } };
}

export function countAnsweredPendingUserInputQuestions(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  return questions.reduce((count, question) => {
    return resolvePendingUserInputAnswer(question, draftAnswers[question.id]) ? count + 1 : count;
  }, 0);
}

export function findFirstUnansweredPendingUserInputQuestionIndex(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  const unansweredIndex = questions.findIndex(
    (question) => !resolvePendingUserInputAnswer(question, draftAnswers[question.id]),
  );

  return unansweredIndex === -1 ? Math.max(questions.length - 1, 0) : unansweredIndex;
}

export function derivePendingUserInputProgress(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  questionIndex: number,
): PendingUserInputProgress {
  const normalizedQuestionIndex =
    questions.length === 0 ? 0 : Math.max(0, Math.min(questionIndex, questions.length - 1));
  const activeQuestion = questions[normalizedQuestionIndex] ?? null;
  const activeDraft = activeQuestion ? draftAnswers[activeQuestion.id] : undefined;
  const resolvedAnswer = activeQuestion
    ? resolvePendingUserInputAnswer(activeQuestion, activeDraft)
    : null;
  const customAnswer = activeDraft?.customAnswer ?? "";
  const answeredQuestionCount = countAnsweredPendingUserInputQuestions(questions, draftAnswers);
  const isLastQuestion =
    questions.length === 0 ? true : normalizedQuestionIndex >= questions.length - 1;

  return {
    questionIndex: normalizedQuestionIndex,
    activeQuestion,
    activeDraft,
    selectedOptionLabels: normalizeSelectedOptionLabels(activeDraft?.selectedOptionLabels),
    customAnswer,
    resolvedAnswer,
    usingCustomAnswer: customAnswer.trim().length > 0,
    answeredQuestionCount,
    isLastQuestion,
    isComplete: buildPendingUserInputResponse(questions, draftAnswers) !== null,
    canAdvance: Boolean(resolvedAnswer) || activeDraft?.skipped === true,
  };
}
