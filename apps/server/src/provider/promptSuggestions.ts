/**
 * Provider-neutral prompt suggestion rules shared by Codex and ACP providers:
 * what the model is asked, how recent conversation context is bounded for
 * isolated samplers, which reasoning effort is preferred, and how the returned
 * single-line suggestion is sanitized.
 *
 * @module provider/promptSuggestions
 */
import type { ServerProviderModel } from "@threadlines/contracts";
import { findReasoningOptionDescriptor } from "@threadlines/shared/model";

/** What the model is asked to predict for the composer's gray follow-up hint. */
export const PROMPT_SUGGESTION_INSTRUCTIONS = `Stop being the assistant for a moment. Predict the next message the user will type in this conversation, so it can be offered in their message box.

Read what they asked for and how the last reply ended. Suggest what they would most likely send next, in their own words and style: a next step, a yes to an option the reply offered, a request to run, check, or fix something. Never suggest thanks, praise, or comments on the reply, and never speak as the assistant.

If there is no clear next message, reply with nothing. Otherwise reply with only the message: one line, at most 12 words, no quotes.`;

/** No Threadlines-generated suggestions while a relevant usage window is this far used. */
export const PROMPT_SUGGESTION_USAGE_CEILING_PERCENT = 90;

/**
 * The reasoning a suggestion asks for, best first, among the levels a model
 * lists: the answer is a dozen words, and the lowest levels can read thin.
 */
const SUGGESTION_EFFORTS = ["low", "minimal", "medium", "none", "off"] as const;

const MAX_SUGGESTION_CHARS = 120;
const MAX_SUGGESTION_WORDS = 20;
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["`", "`"],
];
const NO_SUGGESTION = /^\(?(?:none|nothing|no suggestion|n\/a)\)?\.?$/iu;

export const PROMPT_SUGGESTION_MAX_MESSAGES = 8;
export const PROMPT_SUGGESTION_MAX_CHARS_PER_MESSAGE = 4_000;
export const PROMPT_SUGGESTION_MAX_TOTAL_CHARS = 12_000;

export interface PromptSuggestionMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/**
 * Keeps the tail of a streaming string up to `maxChars`, so a long reply keeps
 * its ending (where next steps and questions usually live).
 */
export function appendTailCapped(current: string, chunk: string, maxChars: number): string {
  if (chunk.length === 0 || maxChars <= 0) return current;
  const combined = current + chunk;
  return combined.length <= maxChars ? combined : combined.slice(combined.length - maxChars);
}

/**
 * The suggestion in a sample's answer, or undefined when it isn't one: no
 * text, more than one line, too long for the box's one line, or a word for
 * "nothing". Quotes the model wrapped it in come off.
 */
export function sanitizePromptSuggestion(text: string | null | undefined): string | undefined {
  let line = text?.trim() ?? "";
  for (const [open, close] of QUOTE_PAIRS) {
    if (line.length > 1 && line.startsWith(open) && line.endsWith(close)) {
      line = line.slice(open.length, -close.length).trim();
      break;
    }
  }
  if (line.length === 0 || /[\r\n]/u.test(line) || NO_SUGGESTION.test(line)) return undefined;
  if (line.length > MAX_SUGGESTION_CHARS) return undefined;
  if (line.split(/\s+/u).length > MAX_SUGGESTION_WORDS) return undefined;
  return line;
}

/**
 * The reasoning effort to ask a suggestion sample for, from the levels a model
 * lists; undefined when it lists none of the light ones or isn't known.
 */
export function selectSuggestionEffort(
  modelEfforts: ReadonlyArray<string> | undefined,
): string | undefined {
  if (modelEfforts === undefined) return undefined;
  return SUGGESTION_EFFORTS.find((effort) => modelEfforts.includes(effort));
}

/**
 * The reasoning levels a model lists, from the instance's catalog; the
 * catalog's default model stands for a turn that named none. Undefined for a
 * model the catalog doesn't know.
 */
export function modelReasoningEfforts(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | undefined,
): ReadonlyArray<string> | undefined {
  const entry =
    model === undefined
      ? models.find((candidate) => candidate.isDefault === true)
      : models.find((candidate) => candidate.slug === model);
  const descriptor = findReasoningOptionDescriptor(entry?.capabilities?.optionDescriptors ?? []);
  return descriptor?.options.map((option) => option.id);
}

/**
 * Builds a bounded prompt for an isolated suggestion call that does not share
 * the thread's live session cache. Keeps the newest messages and the tail of
 * each long message so the end of the last reply stays intact.
 */
export function buildTranscriptPromptSuggestionPrompt(
  messages: ReadonlyArray<PromptSuggestionMessage>,
): string | undefined {
  const nonEmpty = messages
    .map((message) => ({ role: message.role, text: message.text.trim() }))
    .filter((message) => message.text.length > 0)
    .slice(-PROMPT_SUGGESTION_MAX_MESSAGES);
  if (nonEmpty.length === 0) return undefined;

  const selectedReversed: Array<string> = [];
  let totalChars = 0;

  for (let index = nonEmpty.length - 1; index >= 0; index -= 1) {
    const message = nonEmpty[index]!;
    const label = message.role === "user" ? "User" : "Assistant";
    const clipped =
      message.text.length <= PROMPT_SUGGESTION_MAX_CHARS_PER_MESSAGE
        ? message.text
        : `...\n${message.text.slice(message.text.length - PROMPT_SUGGESTION_MAX_CHARS_PER_MESSAGE)}`;
    const block = `${label}:\n${clipped}`;
    const remainingBudget = PROMPT_SUGGESTION_MAX_TOTAL_CHARS - totalChars;
    if (remainingBudget <= 0) break;
    if (block.length <= remainingBudget) {
      selectedReversed.push(block);
      totalChars += block.length + 2;
      continue;
    }
    if (selectedReversed.length === 0) {
      const prefix = `${label}:\n...\n`;
      const available = Math.max(0, remainingBudget - prefix.length);
      selectedReversed.push(
        available > 0 ? `${prefix}${message.text.slice(message.text.length - available)}` : label,
      );
    }
    break;
  }

  const transcript = selectedReversed.reverse().join("\n\n");
  return `${PROMPT_SUGGESTION_INSTRUCTIONS}

Do not use any tools.

<conversation>
${transcript}
</conversation>`;
}
