import type { ChatMessage } from "../../types";

/** How far back the composer's Up arrow reaches. */
const RECALL_LIMIT = 50;

/**
 * What the user wrote in this thread, newest first, the way the composer's Up
 * arrow walks it: their own messages only (no agent's words, side questions,
 * invites, a child thread's report or an outside agent's prompt), each one
 * once in a row.
 */
export function recallablePrompts(messages: ReadonlyArray<ChatMessage>): string[] {
  const prompts: string[] = [];
  for (let index = messages.length - 1; index >= 0 && prompts.length < RECALL_LIMIT; index -= 1) {
    const message = messages[index]!;
    if (
      message.role !== "user" ||
      message.fromAgent !== undefined ||
      message.fromThread !== undefined ||
      message.fromOutside !== undefined ||
      message.sideTurnId !== undefined ||
      message.requestKind !== undefined
    ) {
      continue;
    }
    const text = message.text.trim();
    if (text.length === 0 || prompts.at(-1) === text) continue;
    prompts.push(text);
  }
  return prompts;
}

/** Where the Up and Down arrows are in a thread's earlier prompts. */
export interface PromptRecall {
  /** Index into `recallablePrompts`, newest at 0. */
  readonly index: number;
  /** The text it put in the box: once edited, the arrows move the caret again. */
  readonly text: string;
}

/**
 * The next step of the composer's prompt recall, or null when the key is not
 * recall's to take. Up from an empty box (or one still holding an unedited
 * recalled prompt) goes back one; Down goes forward, and past the newest
 * empties the box. At the oldest, Up stays put.
 */
export function stepPromptRecall(input: {
  readonly key: "ArrowUp" | "ArrowDown";
  readonly value: string;
  readonly recall: PromptRecall | null;
  readonly prompts: ReadonlyArray<string>;
}): { readonly recall: PromptRecall | null; readonly value: string } | null {
  const { key, value, prompts } = input;
  const recall = input.recall !== null && input.recall.text === value ? input.recall : null;
  if (key === "ArrowUp") {
    if (recall === null && value.length > 0) return null;
    const index = recall === null ? 0 : recall.index + 1;
    const text = prompts[index];
    if (text === undefined) return recall === null ? null : { recall, value };
    return { recall: { index, text }, value: text };
  }
  if (recall === null) return null;
  if (recall.index === 0) return { recall: null, value: "" };
  const index = recall.index - 1;
  const text = prompts[index]!;
  return { recall: { index, text }, value: text };
}
