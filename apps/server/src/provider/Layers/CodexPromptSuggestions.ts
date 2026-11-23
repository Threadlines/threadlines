/**
 * Codex's suggestion of the user's next message (the gray text in the
 * composer, taken with Tab), made by Threadlines since Codex makes none of its
 * own: after a turn the user started, one `thread/sample` answer from a hidden
 * copy of the thread (CodexSessionRuntime.sampleThread) reusing its cached
 * context. Shared prompt, sanitizer, and effort selection live in
 * `provider/promptSuggestions.ts`.
 *
 * @module provider/Layers/CodexPromptSuggestions
 */
import {
  PROMPT_SUGGESTION_INSTRUCTIONS,
  PROMPT_SUGGESTION_USAGE_CEILING_PERCENT,
  modelReasoningEfforts,
  sanitizePromptSuggestion,
  selectSuggestionEffort,
} from "../promptSuggestions.ts";

/** What the hidden copy is asked (Codex takes at most 4,000 bytes). */
export const CODEX_SUGGESTION_PROMPT = PROMPT_SUGGESTION_INSTRUCTIONS;

/** No suggestions while any plan-wide usage window is this far used. */
export const CODEX_SUGGESTION_USAGE_CEILING_PERCENT = PROMPT_SUGGESTION_USAGE_CEILING_PERCENT;

export const codexSuggestionFromSample = sanitizePromptSuggestion;
export const codexSuggestionEffort = selectSuggestionEffort;
export { modelReasoningEfforts };
