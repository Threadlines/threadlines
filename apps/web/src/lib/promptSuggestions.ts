import type { OrchestrationThreadActivity, TurnId } from "@threadlines/contracts";

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

    const suggestion = asTrimmedString(asRecord(activity.payload)?.suggestion);
    if (suggestion) {
      return suggestion;
    }
  }

  return null;
}
