import type {
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
  TurnId,
} from "@threadlines/contracts";
import type { SessionPhase } from "../types";

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

export function deriveLatestPromptSuggestion(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options?: {
    readonly turnId?: TurnId | null | undefined;
    /** Only suggestions this accepts; see `isFromRecipient`. */
    readonly accept?: ((activity: OrchestrationThreadActivity) => boolean) | undefined;
  },
): string | null {
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
      return suggestion;
    }
  }

  return null;
}

export interface PromptSuggestionSelectionInput {
  /**
   * Suggestions are a Claude-only affordance: the agent the next message goes
   * to (in a room, the one the composer addresses) must be a Claude agent.
   */
  readonly isSuggestionProvider: boolean;
  /**
   * In a room, whether a suggestion came from the agent the next message goes
   * to. A suggestion is that agent's guess at what you'd say to it, so another
   * agent's never shows. Absent: every suggestion is the thread's own agent's.
   */
  readonly isFromRecipient?: ((activity: OrchestrationThreadActivity) => boolean) | undefined;
  readonly composerIsEmpty: boolean;
  readonly phase: SessionPhase;
  /**
   * In a room, an agent answering on the side. It counts as work in progress
   * like a running turn, and its answer lands where the suggestion floats.
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
   * The turn whose suggestion the user has already acted on by sending a
   * follow-up. Its suggestion stays hidden until a newer turn completes, so it
   * does not flash back over the composer during the connecting / awaiting
   * response window where the composer is empty but the new turn has not
   * registered yet.
   */
  readonly dismissedTurnId: TurnId | null;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

/**
 * Decide which prompt suggestion (if any) to surface over the composer. Kept as
 * a pure function so the gating can be unit tested without rendering the
 * composer.
 */
export function selectPromptSuggestion(input: PromptSuggestionSelectionInput): string | null {
  if (!input.isSuggestionProvider) {
    return null;
  }
  if (!input.composerIsEmpty) {
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

  return deriveLatestPromptSuggestion(input.activities, {
    turnId: latestTurn.turnId,
    accept: input.isFromRecipient,
  });
}
