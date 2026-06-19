import type {
  ServerProvider,
  ServerProviderAccountUsage,
  ServerProviderAccountTokenUsage,
  ServerProviderSpendControlLimit,
  ServerProviderUsageLimit,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

export interface ProviderAccountUsageWindowPresentation {
  readonly key: "primary" | "secondary";
  readonly label: string;
  readonly detail: string;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly reachedLimit: boolean;
}

export interface ProviderAccountUsageSpendControlPresentation {
  readonly label: string;
  readonly detail: string;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly reachedLimit: boolean;
}

export interface ProviderAccountUsageResetCreditsPresentation {
  readonly availableCount: number;
  readonly label: string;
  readonly detail: string;
}

export interface ProviderAccountTokenUsageBucketPresentation {
  readonly startDate: string;
  readonly label: string;
  readonly tokens: number;
  readonly tokenLabel: string;
  readonly intensityPercent: number;
}

export interface ProviderAccountTokenUsageSummaryPresentation {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

export interface ProviderAccountTokenUsagePresentation {
  readonly label: string;
  readonly summary: ReadonlyArray<ProviderAccountTokenUsageSummaryPresentation>;
  readonly buckets: ReadonlyArray<ProviderAccountTokenUsageBucketPresentation>;
}

export interface ProviderAccountUsagePresentation {
  readonly label: string;
  readonly spendControl?: ProviderAccountUsageSpendControlPresentation;
  readonly resetCredits?: ProviderAccountUsageResetCreditsPresentation;
  readonly tokenUsage?: ProviderAccountTokenUsagePresentation;
  readonly windows: ReadonlyArray<ProviderAccountUsageWindowPresentation>;
  readonly reachedLimit: boolean;
}

type ProviderAccountUsagePresentationProvider = Pick<
  ServerProvider,
  "accountUsage" | "auth" | "driver"
>;

function normalizeResetTimestampMs(resetsAt: number | undefined): number | null {
  if (!Number.isFinite(resetsAt) || resetsAt === undefined || resetsAt <= 0) return null;
  return resetsAt < 10_000_000_000 ? resetsAt * 1000 : resetsAt;
}

function formatResetDetail(resetsAt: number | undefined, nowMs: number): string | null {
  const resetMs = normalizeResetTimestampMs(resetsAt);
  if (resetMs === null) return null;

  const diffMinutes = Math.ceil((resetMs - nowMs) / 60_000);
  if (diffMinutes <= 0) return "resets now";
  if (diffMinutes < 60) return `resets in ${diffMinutes}m`;

  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  if (hours < 24) {
    return minutes > 0 ? `resets in ${hours}h ${minutes}m` : `resets in ${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `resets in ${days}d ${remainingHours}h` : `resets in ${days}d`;
}

function selectProviderUsageLimit(
  usage: ServerProviderAccountUsage,
): ServerProviderUsageLimit | null {
  if (usage.primaryLimitId) {
    const primaryLimit = usage.limits.find((limit) => limit.limitId === usage.primaryLimitId);
    if (primaryLimit) return primaryLimit;
  }
  return (
    usage.limits.find((limit) => limit.limitId === "codex") ??
    usage.limits.find((limit) => limit.primary || limit.secondary) ??
    usage.limits[0] ??
    null
  );
}

function formatUsageWindowDurationLabel(
  window: ServerProviderUsageWindow,
  fallback: string,
): string {
  const minutes = window.windowDurationMins;
  if (!Number.isFinite(minutes) || minutes === undefined || minutes <= 0) return fallback;
  if (minutes === 300) return "5h";
  if (minutes === 1_440) return "Daily";
  if (minutes === 10_080) return "Weekly";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatUsageWindowPresentation(
  key: ProviderAccountUsageWindowPresentation["key"],
  window: ServerProviderUsageWindow,
  reachedLimit: boolean,
  nowMs: number,
): ProviderAccountUsageWindowPresentation {
  const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
  const remainingPercent = Math.max(0, Math.min(100, window.remainingPercent));
  const windowReachedLimit = reachedLimit || usedPercent >= 100 || remainingPercent <= 0;
  const resetDetail = formatResetDetail(window.resetsAt, nowMs);
  const detailParts = [
    windowReachedLimit ? "limit reached" : `${remainingPercent}% remaining`,
    resetDetail,
  ].filter((part): part is string => Boolean(part));

  return {
    key,
    label: formatUsageWindowDurationLabel(window, key === "primary" ? "5h" : "Weekly"),
    detail: detailParts.join(" · "),
    usedPercent,
    remainingPercent,
    reachedLimit: windowReachedLimit,
  };
}

function formatSpendControlPresentation(
  limit: ServerProviderSpendControlLimit,
  reachedLimit: boolean,
  nowMs: number,
): ProviderAccountUsageSpendControlPresentation {
  const remainingPercent = Math.max(0, Math.min(100, limit.remainingPercent));
  const usedPercent = Math.max(0, 100 - remainingPercent);
  const spendControlReachedLimit = reachedLimit || usedPercent >= 100 || remainingPercent <= 0;
  const resetDetail = formatResetDetail(limit.resetsAt, nowMs);
  const detailParts = [
    `${limit.used} used of ${limit.limit}`,
    spendControlReachedLimit ? "limit reached" : `${remainingPercent}% remaining`,
    resetDetail,
  ].filter((part): part is string => Boolean(part));

  return {
    label: "Monthly",
    detail: detailParts.join(" - "),
    usedPercent,
    remainingPercent,
    reachedLimit: spendControlReachedLimit,
  };
}

function formatResetCreditsPresentation(
  usage: ServerProviderAccountUsage,
): ProviderAccountUsageResetCreditsPresentation | undefined {
  const availableCount =
    usage.rateLimitResetCredits?.availableCount ??
    (usage.source === "codex-rate-limits" ? 0 : undefined);
  if (availableCount === undefined || !Number.isInteger(availableCount) || availableCount < 0) {
    return undefined;
  }

  return {
    availableCount,
    label: availableCount === 1 ? "1 reset available" : `${availableCount} resets available`,
    detail: "usable for 30 days after grant",
  };
}

export function formatProviderTokenCount(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value) || value < 0) return null;
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  const billionPrecision = value < 10_000_000_000 ? 2 : 1;
  return `${(value / 1_000_000_000).toFixed(billionPrecision).replace(/\.?0+$/, "")}B`;
}

function formatDurationSeconds(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value) || value < 0) return null;
  const seconds = Math.round(value);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatDayCount(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value) || value < 0) return null;
  const rounded = Math.round(value);
  return rounded === 1 ? "1d" : `${rounded}d`;
}

function formatUsageBucketLabel(startDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(startDate);
  if (!match) return startDate;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatTokenUsagePresentation(
  usage: ServerProviderAccountTokenUsage | undefined,
): ProviderAccountTokenUsagePresentation | undefined {
  if (!usage) return undefined;

  const peakTokens = Math.max(0, ...usage.dailyBuckets.map((bucket) => bucket.tokens));
  const buckets = usage.dailyBuckets.map((bucket) => ({
    startDate: bucket.startDate,
    label: formatUsageBucketLabel(bucket.startDate),
    tokens: bucket.tokens,
    tokenLabel: formatProviderTokenCount(bucket.tokens) ?? "0",
    intensityPercent:
      peakTokens > 0 ? Math.max(6, Math.round((bucket.tokens / peakTokens) * 100)) : 0,
  }));

  const summary: ProviderAccountTokenUsageSummaryPresentation[] = [];
  const lifetimeTokens = formatProviderTokenCount(usage.summary.lifetimeTokens);
  if (lifetimeTokens) {
    summary.push({ key: "lifetimeTokens", label: "Lifetime tokens", value: lifetimeTokens });
  }
  const peakDailyTokens = formatProviderTokenCount(usage.summary.peakDailyTokens);
  if (peakDailyTokens) {
    summary.push({ key: "peakDailyTokens", label: "Peak tokens", value: peakDailyTokens });
  }
  const longestTurn = formatDurationSeconds(usage.summary.longestRunningTurnSec);
  if (longestTurn) {
    summary.push({ key: "longestRunningTurnSec", label: "Longest task", value: longestTurn });
  }
  const currentStreak = formatDayCount(usage.summary.currentStreakDays);
  if (currentStreak) {
    summary.push({ key: "currentStreakDays", label: "Current streak", value: currentStreak });
  }
  const longestStreak = formatDayCount(usage.summary.longestStreakDays);
  if (longestStreak) {
    summary.push({ key: "longestStreakDays", label: "Longest streak", value: longestStreak });
  }

  if (summary.length === 0 && buckets.length === 0) return undefined;
  return {
    label: "Token history",
    summary,
    buckets,
  };
}

const PROVIDER_USAGE_SOURCE_LABELS: Record<ServerProviderAccountUsage["source"], string> = {
  "codex-rate-limits": "Codex usage",
  "claude-oauth-usage": "Claude usage",
};

export function deriveProviderAccountUsagePresentation(
  usage: ServerProviderAccountUsage | undefined,
  nowMs: number = Date.now(),
): ProviderAccountUsagePresentation | null {
  if (!usage || !(usage.source in PROVIDER_USAGE_SOURCE_LABELS)) return null;

  const resetCredits = formatResetCreditsPresentation(usage);
  const tokenUsage = formatTokenUsagePresentation(usage.tokenUsage);
  const limit = selectProviderUsageLimit(usage);
  if (!limit) {
    return resetCredits || tokenUsage
      ? {
          label: PROVIDER_USAGE_SOURCE_LABELS[usage.source],
          ...(resetCredits ? { resetCredits } : {}),
          ...(tokenUsage ? { tokenUsage } : {}),
          windows: [],
          reachedLimit: false,
        }
      : null;
  }

  const reachedLimit = Boolean(limit.rateLimitReachedType);
  const windows = [
    ...(limit.primary
      ? [formatUsageWindowPresentation("primary", limit.primary, reachedLimit, nowMs)]
      : []),
    ...(limit.secondary
      ? [formatUsageWindowPresentation("secondary", limit.secondary, reachedLimit, nowMs)]
      : []),
  ];
  const spendControl = limit.individualLimit
    ? formatSpendControlPresentation(limit.individualLimit, reachedLimit, nowMs)
    : undefined;
  if (windows.length === 0 && !spendControl && !resetCredits && !tokenUsage) return null;

  return {
    label: limit.limitName ?? PROVIDER_USAGE_SOURCE_LABELS[usage.source],
    ...(spendControl ? { spendControl } : {}),
    ...(resetCredits ? { resetCredits } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    windows,
    reachedLimit:
      reachedLimit ||
      Boolean(spendControl?.reachedLimit) ||
      windows.some((window) => window.reachedLimit),
  };
}

function shouldShowClaudeUsageUnavailablePlaceholder(
  provider: ProviderAccountUsagePresentationProvider,
): boolean {
  return (
    provider.driver === "claudeAgent" &&
    provider.auth.status === "authenticated" &&
    provider.auth.type?.toLowerCase() !== "apikey"
  );
}

function makeClaudeUsageUnavailablePresentation(): ProviderAccountUsagePresentation {
  return {
    label: PROVIDER_USAGE_SOURCE_LABELS["claude-oauth-usage"],
    reachedLimit: false,
    windows: [
      {
        key: "primary",
        label: "5h",
        detail: "usage unavailable",
        usedPercent: 0,
        remainingPercent: 100,
        reachedLimit: false,
      },
      {
        key: "secondary",
        label: "Weekly",
        detail: "usage unavailable",
        usedPercent: 0,
        remainingPercent: 100,
        reachedLimit: false,
      },
    ],
  };
}

export function deriveProviderAccountUsagePresentationForProvider(
  provider: ProviderAccountUsagePresentationProvider | null | undefined,
  nowMs: number = Date.now(),
): ProviderAccountUsagePresentation | null {
  const presentation = deriveProviderAccountUsagePresentation(provider?.accountUsage, nowMs);
  if (presentation || !provider) return presentation;
  if (shouldShowClaudeUsageUnavailablePlaceholder(provider)) {
    return makeClaudeUsageUnavailablePresentation();
  }
  return null;
}

/**
 * True when any tracked window or spend control is at/near its cap — used
 * by ambient indicators (composer meter dot) that should only light up when
 * the user is about to be throttled.
 */
export function isProviderUsageNearLimit(
  presentation: ProviderAccountUsagePresentation | null,
  thresholdPercent = 90,
): boolean {
  if (!presentation) return false;
  if (presentation.reachedLimit) return true;
  if (
    presentation.spendControl &&
    (presentation.spendControl.reachedLimit ||
      presentation.spendControl.usedPercent >= thresholdPercent)
  ) {
    return true;
  }
  return presentation.windows.some(
    (window) => window.reachedLimit || window.usedPercent >= thresholdPercent,
  );
}
