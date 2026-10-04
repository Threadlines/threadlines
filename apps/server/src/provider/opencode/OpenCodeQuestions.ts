/**
 * OpenCodeQuestions — OpenCode forms as Threadlines user-input questions.
 *
 * OpenCode's `question` tool asks through a form: one field per question,
 * `string` (single choice) or `multiselect`, with `custom: true` allowing a
 * typed answer. The chat answers with option labels or free text, so labels
 * are mapped back to the option values the form expects. Forms with other
 * field types (numbers, booleans, external flows) are not questions the chat
 * can show; the adapter declines them with a note so the model moves on.
 *
 * @module provider/opencode/OpenCodeQuestions
 */
import type { ProviderUserInputAnswers, UserInputQuestion } from "@threadlines/contracts";

import type { OpenCodeForm, OpenCodeFormField } from "./OpenCodeEvents.ts";

const QUESTION_FIELD_TYPES = new Set(["string", "multiselect"]);

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function optionLabel(option: NonNullable<OpenCodeFormField["options"]>[number]): string {
  return nonEmpty(option.label) ?? (typeof option.value === "string" ? option.value : "");
}

/** Whether every field of the form is one the chat can ask. */
export function isOpenCodeQuestionForm(form: OpenCodeForm): boolean {
  return (
    form.fields.length > 0 && form.fields.every((field) => QUESTION_FIELD_TYPES.has(field.type))
  );
}

export function openCodeFormQuestions(form: OpenCodeForm): ReadonlyArray<UserInputQuestion> {
  return form.fields.map((field, index) => {
    const header = nonEmpty(field.title) ?? nonEmpty(form.title) ?? `Question ${index + 1}`;
    return {
      id: field.key,
      header,
      question: nonEmpty(field.description) ?? header,
      options: (field.options ?? []).flatMap((option) => {
        const label = optionLabel(option);
        return label ? [{ label, description: nonEmpty(option.description) ?? label }] : [];
      }),
      multiSelect: field.type === "multiselect",
    };
  });
}

function valueForLabel(field: OpenCodeFormField, answer: string): string {
  const option = field.options?.find((candidate) => optionLabel(candidate) === answer);
  return option && typeof option.value === "string" ? option.value : answer;
}

/**
 * The form answer for the chat's answers, or `undefined` when nothing usable
 * was answered (the user dismissed the question).
 */
export function openCodeFormAnswer(
  form: OpenCodeForm,
  answers: ProviderUserInputAnswers,
): Record<string, string | ReadonlyArray<string>> | undefined {
  const answer: Record<string, string | ReadonlyArray<string>> = {};
  for (const field of form.fields) {
    const raw = answers[field.key];
    const values = (Array.isArray(raw) ? raw : [raw])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .map((value) => valueForLabel(field, value));
    if (values.length === 0) continue;
    answer[field.key] = field.type === "multiselect" ? values : values[0]!;
  }
  return Object.keys(answer).length > 0 ? answer : undefined;
}
