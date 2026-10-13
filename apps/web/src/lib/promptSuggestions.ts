import type {
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
  ProviderDriverKind,
  TurnId,
} from "@threadlines/contracts";
import type { SessionPhase } from "../types";

/** An agent's guess at the next message, shown in the composer. */
export interface PromptSuggestion {
  /** The activity that carried it; a new suggestion has a new id. */
  readonly id: string;
  /** As shown and as filled in: trimmed, first letter capitalized. */
  readonly text: string;
}

/**
 * Suggestions recorded before the projection stamped their provider. Only
 * Claude made suggestions then.
 */
const UNSTAMPED_SUGGESTION_PROVIDER = "claudeAgent";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatPromptSuggestionText(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/** The kind of agent that made a suggestion. */
function promptSuggestionProvider(activity: OrchestrationThreadActivity): string {
  return asTrimmedString(asRecord(activity.payload)?.provider) ?? UNSTAMPED_SUGGESTION_PROVIDER;
}

export function deriveLatestPromptSuggestion(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options?: {
    readonly turnId?: TurnId | null | undefined;
    /** Only suggestions this accepts; see `isFromRecipient`. */
    readonly accept?: ((activity: OrchestrationThreadActivity) => boolean) | undefined;
  },
): PromptSuggestion | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "prompt-suggestion.updated") {
      continue;
    }
    if (options?.turnId !== undefined && activity.turnId !== options.turnId) {
      continue;
    }
    if (options?.accept !== undefined && !options.accept(activity)) {
      continue;
    }

    const suggestion = asTrimmedString(asRecord(activity.payload)?.suggestion);
    if (suggestion) {
      return { id: activity.id, text: formatPromptSuggestionText(suggestion) };
    }
  }

  return null;
}

export interface PromptSuggestionSelectionInput {
  /**
   * The kind of agent the next message goes to (in a room, the one the
   * composer addresses). A suggestion is its maker's guess at what you'd say
   * to it, so it shows only while the next message goes to the same kind of
   * agent: switching a thread from Claude to Codex hides Claude's.
   */
  readonly recipientDriverKind: ProviderDriverKind | undefined;
  /**
   * In a room, whether a suggestion came from the agent the next message goes
   * to. Another agent's never shows, even one of the same kind. Absent: every
   * suggestion is the thread's own agent's.
   */
  readonly isFromRecipient?: ((activity: OrchestrationThreadActivity) => boolean) | undefined;
  readonly phase: SessionPhase;
  /**
   * In a room, an agent answering on the side. It counts as work in progress
   * like a running turn.
   */
  readonly sideAnswerInProgress: boolean;
  readonly isSendBusy: boolean;
  readonly hasComposerApproval: boolean;
  readonly pendingUserInputCount: number;
  readonly showPlanFollowUpPrompt: boolean;
  /** Messages waiting above the composer: the next message is already decided. */
  readonly queuedMessageCount: number;
  readonly latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "state"> | null;
  /**
   * The turn whose suggestion the user already acted on, by sending a
   * follow-up or by pressing Escape. Its suggestion stays hidden until a newer
   * turn completes, so it does not flash back over the composer during the
   * connecting / awaiting response window where the composer is empty but the
   * new turn has not registered yet.
   */
  readonly dismissedTurnId: TurnId | null;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

/**
 * Decide which prompt suggestion (if any) the composer offers. What is typed
 * decides how it shows; see `resolvePromptSuggestionView`. Kept as a pure
 * function so the gating can be unit tested without rendering the composer.
 */
export function selectPromptSuggestion(
  input: PromptSuggestionSelectionInput,
): PromptSuggestion | null {
  if (input.recipientDriverKind === undefined) {
    return null;
  }
  if (
    input.phase === "running" ||
    input.sideAnswerInProgress ||
    input.isSendBusy ||
    input.hasComposerApproval ||
    input.pendingUserInputCount > 0 ||
    input.queuedMessageCount > 0
  ) {
    return null;
  }
  if (input.showPlanFollowUpPrompt) {
    return null;
  }

  const latestTurn = input.latestTurn;
  if (!latestTurn || latestTurn.state !== "completed") {
    return null;
  }
  if (input.dismissedTurnId !== null && latestTurn.turnId === input.dismissedTurnId) {
    return null;
  }

  const recipientDriverKind = input.recipientDriverKind;
  const isFromRecipient = input.isFromRecipient;
  return deriveLatestPromptSuggestion(input.activities, {
    turnId: latestTurn.turnId,
    accept: (activity) =>
      promptSuggestionProvider(activity) === recipientDriverKind &&
      (isFromRecipient === undefined || isFromRecipient(activity)),
  });
}

/**
 * How a suggestion shows for what is typed:
 * - `placeholder`: the box is empty; the suggestion takes the hint's place.
 * - `completion`: the typed text starts the suggestion (ignoring case), so
 *   the rest stays in gray after the cursor and Tab finishes it.
 * Null hides it. Only one plain line with the cursor at its end completes:
 * the editor draws "@" and "$" tokens as chips and a leading "/" as a
 * command, which the gray rest could not line up with.
 */
export type PromptSuggestionView =
  | { readonly kind: "placeholder" }
  | { readonly kind: "completion"; readonly remainder: string };

export function resolvePromptSuggestionView(input: {
  readonly prompt: string;
  /** Where the cursor sits in `prompt`. */
  readonly cursor: number;
  readonly suggestion: string;
}): PromptSuggestionView | null {
  const { prompt, suggestion } = input;
  if (prompt.length === 0) {
    return { kind: "placeholder" };
  }
  if (input.cursor !== prompt.length || prompt.length >= suggestion.length) {
    return null;
  }
  if (/[\n@$]/.test(prompt) || prompt.startsWith("/")) {
    return null;
  }
  if (suggestion.slice(0, prompt.length).toLowerCase() !== prompt.toLowerCase()) {
    return null;
  }
  return { kind: "completion", remainder: suggestion.slice(prompt.length) };
}
