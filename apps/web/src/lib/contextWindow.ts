import type { OrchestrationThreadActivity, ThreadTokenUsageSnapshot } from "@threadlines/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

type ContextWindowCategories = NonNullable<ThreadTokenUsageSnapshot["contextCategories"]>;

/** Keeps the provider's order (legend colors are assigned by index) and drops
 *  entries the provider sent malformed rather than failing the whole snapshot. */
function asContextCategories(value: unknown): ContextWindowCategories | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const categories = value.flatMap((entry) => {
    const record = asRecord(entry);
    const name = typeof record?.name === "string" ? record.name.trim() : "";
    const tokens = asFiniteNumber(record?.tokens);
    if (name.length === 0 || tokens === null || tokens < 0) {
      return [];
    }
    return [{ name, tokens }];
  });

  return categories.length > 0 ? categories : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const usedTokens = asFiniteNumber(payload?.usedTokens);
    if (usedTokens === null || usedTokens <= 0) {
      continue;
    }

    const maxTokens = asFiniteNumber(payload?.maxTokens);
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(payload?.totalProcessedTokens),
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: asFiniteNumber(payload?.inputTokens),
      cachedInputTokens: asFiniteNumber(payload?.cachedInputTokens),
      outputTokens: asFiniteNumber(payload?.outputTokens),
      reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
      lastInputTokens: asFiniteNumber(payload?.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(payload?.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(payload?.toolUses),
      durationMs: asFiniteNumber(payload?.durationMs),
      compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
      contextCategories: asContextCategories(payload?.contextCategories),
      updatedAt: activity.createdAt,
    };
  }

  return null;
}

export type CachedInputRate = {
  readonly percentage: number;
  readonly cachedTokens: number;
  readonly inputTokens: number;
};

/** Share of session input tokens served from the provider's prompt cache.
 *  Null unless both totals are known and there was any input to cache. */
export function deriveCachedInputRate(
  snapshot: ContextWindowSnapshot | null,
): CachedInputRate | null {
  const inputTokens = snapshot?.inputTokens ?? null;
  const cachedTokens = snapshot?.cachedInputTokens ?? null;
  if (inputTokens === null || cachedTokens === null || inputTokens <= 0) {
    return null;
  }

  const percentage = Math.max(0, Math.min(100, (cachedTokens / inputTokens) * 100));
  return { percentage, cachedTokens, inputTokens };
}

/** Truncates to one decimal instead of rounding: a displayed percentage never
 *  claims more than the data supports (99.97% shows as 99.9%, never 100%). */
export function formatContextWindowPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const clamped = Math.max(0, Math.min(100, value));
  return `${(Math.floor(clamped * 10) / 10).toFixed(1).replace(/\.0$/, "")}%`;
}

/** Truncates at the displayed precision instead of rounding, so a count never
 *  reads higher than the real value (96,632 shows as 96.6k, never 97k). */
export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.trunc(value)}`;
  }
  if (value < 1_000_000) {
    return `${(Math.floor(value / 100) / 10).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${(Math.floor(value / 100_000) / 10).toFixed(1).replace(/\.0$/, "")}m`;
}

/** Width-budgeted labels (the agents panel's `model · effort · tokens` meta
 *  line) drop the k-range decimal so the line keeps fitting its 330px row.
 *  Still truncated, never rounded up: 48,999 shows as 48k, not 49k. */
export function formatContextWindowTokensCompact(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 10_000) {
    return formatContextWindowTokens(value);
  }
  if (value < 1_000_000) {
    return `${Math.floor(value / 1_000)}k`;
  }
  return formatContextWindowTokens(value);
}
