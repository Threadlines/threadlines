/**
 * Codex's suggestion of the user's next message (the gray text in the
 * composer, taken with Tab), made by Threadlines since Codex makes none of its
 * own: after a turn the user started, one `thread/sample` answer from a hidden
 * copy of the thread (CodexSessionRuntime.sampleThread) reusing its cached
 * context. This module holds what is asked and what of the answer is kept.
 *
 * @module provider/Layers/CodexPromptSuggestions
 */
import type { ServerProviderModel } from "@threadlines/contracts";
import { findReasoningOptionDescriptor } from "@threadlines/shared/model";

/** What the hidden copy is asked (Codex takes at most 4,000 bytes). */
export const CODEX_SUGGESTION_PROMPT = `Stop being the assistant for a moment. Predict the next message the user will type in this conversation, so it can be offered in their message box.

Read what they asked for and how the last reply ended. Suggest what they would most likely send next, in their own words and style: a next step, a yes to an option the reply offered, a request to run, check, or fix something. Never suggest thanks, praise, or comments on the reply, and never speak as the assistant.

If there is no clear next message, reply with nothing. Otherwise reply with only the message: one line, at most 12 words, no quotes.`;

/** No suggestions while any plan-wide usage window is this far used. */
export const CODEX_SUGGESTION_USAGE_CEILING_PERCENT = 90;

/**
 * The reasoning a suggestion asks for, best first, among the levels a model
 * lists: the answer is a dozen words, and the lowest levels can read thin.
 */
const SUGGESTION_EFFORTS = ["low", "minimal", "medium", "none"] as const;

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

/**
 * The suggestion in a sample's answer, or undefined when it isn't one: no
 * text, more than one line, too long for the box's one line, or a word for
 * "nothing". Quotes the model wrapped it in come off.
 */
export function codexSuggestionFromSample(text: string | null | undefined): string | undefined {
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
 * The reasoning effort to ask a sample for, from the levels the thread's
 * model lists; none (the thread's own) when it lists none of the light ones
 * or isn't known. Codex applies it only where the model can change effort
 * without losing the cache.
 */
export function codexSuggestionEffort(
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
