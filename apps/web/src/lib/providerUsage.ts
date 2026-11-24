import type {
  ServerProvider,
  ServerProviderAccountUsage,
  ServerProviderAccountTokenUsage,
  ServerProviderRateLimitResetCredit,
  ServerProviderScopedUsageWindow,
  ServerProviderSpendControlLimit,
  ServerProviderUsageLimit,
  ServerProviderUsageWindow,
} from "@threadlines/contracts";
import { type UsageScope, usageScopeHoldsModel } from "@threadlines/shared/usageLimits";

/**
 * `warning` is the single "render attention affordances" signal for usage
 * bars: it folds together reached limits, the local near-limit threshold,
 * and provider-reported severity so components never re-derive it.
 */
export interface ProviderAccountUsageWindowPresentation {
  readonly key: string;
  readonly label: string;
  /**
   * The label without its window length, for compact stacks ("Fable" for
   * "Fable (weekly)"). Unset when the label is already as short as it gets.
   */
  readonly shortLabel?: string;
  readonly detail: string;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly reachedLimit: boolean;
  readonly warning: boolean;
  /**
   * How much of the window has passed (0-100), where a usage bar draws its
   * pace mark: usage left of the mark is on track to last until the reset.
   * Set only for weekly (and longer) windows whose length and reset time are
   * known; short session windows such as 5h have no pace mark.
   */
  readonly elapsedPercent?: number;
  /**
   * The pace mark's hover text, "44% of the week has passed". Set exactly
   * when `elapsedPercent` is.
   */
  readonly paceDetail?: string;
  /**
   * Set on a window that caps one model, not the whole account (Claude's
   * per-model weekly limits): the name the provider gives it ("Fable"), its
   * period ("Weekly"), and when it resets ("resets in 3d 16h").
   */
  readonly scope?: UsageScope & {
    readonly period: string | null;
    readonly resetDetail: string | null;
  };
}

export interface ProviderAccountUsageSpendControlPresentation {
  readonly label: string;
  readonly detail: string;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly reachedLimit: boolean;
  readonly warning: boolean;
}

export interface ProviderAccountUsageResetCreditsPresentation {
  readonly availableCount: number;
  readonly label: string;
  /** Compact availability copy for dense rows, e.g. "4 available". */
  readonly shortLabel: string;
  readonly detail: string;
  /** Highest expiration urgency among usable credits — render attention affordances. */
  readonly expirationUrgency?: ProviderRateLimitResetCreditAttentionUrgency;
}

const RESET_CREDIT_DAY_MS = 24 * 60 * 60 * 1000;
const RESET_CREDIT_CRITICAL_EXPIRATION_MS = 2 * RESET_CREDIT_DAY_MS;
const RESET_CREDIT_SOON_EXPIRATION_MS = 7 * RESET_CREDIT_DAY_MS;

export type ProviderRateLimitResetCreditUrgency = "expired" | "critical" | "soon" | "normal";

export function providerRateLimitResetCreditExpirationUrgency(
  expiresAt: number | undefined,
  nowMs = Date.now(),
): ProviderRateLimitResetCreditUrgency {
  const expiresAtMs = normalizeResetTimestampMs(expiresAt);
  if (expiresAtMs === null) return "normal";
  const remainingMs = expiresAtMs - nowMs;
  if (remainingMs <= 0) return "expired";
  if (remainingMs < RESET_CREDIT_CRITICAL_EXPIRATION_MS) return "critical";
  if (remainingMs < RESET_CREDIT_SOON_EXPIRATION_MS) return "soon";
  return "normal";
}

export type ProviderRateLimitResetCreditAttentionUrgency = Extract<
  ProviderRateLimitResetCreditUrgency,
  "soon" | "critical"
>;

function soonestUsableResetCreditExpirationMs(
  credits: ReadonlyArray<ServerProviderRateLimitResetCredit> | undefined,
  nowMs: number,
): number | null {
  let soonest: number | null = null;
  for (const credit of credits ?? []) {
    if (credit.status !== "available") continue;
    const expiresAtMs = normalizeResetTimestampMs(credit.expiresAt);
    if (expiresAtMs === null || expiresAtMs <= nowMs) continue;
    if (soonest === null || expiresAtMs < soonest) soonest = expiresAtMs;
  }
  return soonest;
}

export function providerRateLimitResetCreditsExpirationUrgency(
  credits: ReadonlyArray<ServerProviderRateLimitResetCredit> | undefined,
  nowMs = Date.now(),
): ProviderRateLimitResetCreditAttentionUrgency | undefined {
  let highest: ProviderRateLimitResetCreditAttentionUrgency | undefined;
  for (const credit of credits ?? []) {
    if (credit.status !== "available") continue;
    const urgency = providerRateLimitResetCreditExpirationUrgency(credit.expiresAt, nowMs);
    if (urgency === "critical") return "critical";
    if (urgency === "soon") highest = "soon";
  }
  return highest;
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
  readonly checkedAt: string;
  readonly scope: "account" | "local";
  readonly coverageStartDate?: string;
  readonly coverageEndDate?: string;
  readonly completeLifetimeHistory: boolean;
  readonly summary: ReadonlyArray<ProviderAccountTokenUsageSummaryPresentation>;
  readonly buckets: ReadonlyArray<ProviderAccountTokenUsageBucketPresentation>;
}

/**
 * A provider whose limit resets can only be spent in the provider's own app.
 * Anthropic offers no public way for another app to claim a Claude reset, so
 * Threadlines links to claude.ai instead of claiming them itself.
 */
export interface ProviderExternalResetsLink {
  readonly label: string;
  readonly url: string;
}

const CLAUDE_EXTERNAL_RESETS_LINK: ProviderExternalResetsLink = {
  label: "Use on claude.ai",
  url: "https://claude.ai/settings/usage",
};

export function providerExternalResetsLink(
  usage: Pick<ServerProviderAccountUsage, "source"> | null | undefined,
): ProviderExternalResetsLink | undefined {
  return usage?.source === "claude-oauth-usage" ? CLAUDE_EXTERNAL_RESETS_LINK : undefined;
}

/**
 * What a usage surface says when the provider could not check usage just now.
 * `signIn` is set only once the provider confirmed its sign-in is gone, so a
 * surface offers Sign in for that and for nothing else.
 */
export interface ProviderAccountUsageNotice {
  readonly text: string;
  readonly signIn: boolean;
}

export interface ProviderAccountUsagePresentation {
  readonly label: string;
  readonly notice?: ProviderAccountUsageNotice;
  readonly spendControl?: ProviderAccountUsageSpendControlPresentation;
  readonly resetCredits?: ProviderAccountUsageResetCreditsPresentation;
  readonly externalResets?: ProviderExternalResetsLink;
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

function formatRemainingDuration(untilMs: number, nowMs: number): string | null {
  const diffMinutes = Math.ceil((untilMs - nowMs) / 60_000);
  if (diffMinutes <= 0) return null;
  if (diffMinutes < 60) return `${diffMinutes}m`;

  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  if (hours < 24) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

/**
 * A provider checks usage every few minutes, so a reading older than this was
 * kept across failed checks and says so.
 */
const USAGE_READING_STALE_AFTER_MS = 10 * 60 * 1000;

function isUsageReadingStale(checkedAt: string | undefined, nowMs: number): boolean {
  const readAtMs = checkedAt === undefined ? Number.NaN : Date.parse(checkedAt);
  return Number.isFinite(readAtMs) && nowMs - readAtMs >= USAGE_READING_STALE_AFTER_MS;
}

/** "as of 25m ago" for a reading kept across failed checks, else null. */
function formatReadingAgeDetail(checkedAt: string | undefined, nowMs: number): string | null {
  if (checkedAt === undefined || !isUsageReadingStale(checkedAt, nowMs)) return null;
  const elapsedMinutes = Math.floor((nowMs - Date.parse(checkedAt)) / 60_000);
  if (elapsedMinutes < 60) return `as of ${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  return elapsedHours < 24
    ? `as of ${elapsedHours}h ago`
    : `as of ${Math.floor(elapsedHours / 24)}d ago`;
}

/**
 * How much of a usage window has passed, from its length and its reset time.
 * Unset for a reading that can't be placed in its window: no length, no reset
 * time, a reset already past, or one further off than the window is long.
 */
export function usageWindowElapsedPercent(
  window: Pick<ServerProviderUsageWindow, "resetsAt" | "windowDurationMins">,
  nowMs: number,
): number | undefined {
  const resetMs = normalizeResetTimestampMs(window.resetsAt);
  const minutes = window.windowDurationMins;
  if (resetMs === null || minutes === undefined || minutes <= 0) return undefined;
  const durationMs = minutes * 60_000;
  const remainingMs = resetMs - nowMs;
  if (remainingMs <= 0 || remainingMs > durationMs) return undefined;
  return Math.round((1 - remainingMs / durationMs) * 1000) / 10;
}

/**
 * Short session windows (such as 5h) are used in bursts, so pace marks and
 * "ahead of pace" apply only to weekly (and longer) windows.
 */
const MIN_PACE_WINDOW_MINS = 7 * 24 * 60;

function usageWindowPaceElapsedPercent(
  window: Pick<ServerProviderUsageWindow, "resetsAt" | "windowDurationMins">,
  nowMs: number,
): number | undefined {
  if (window.windowDurationMins === undefined || window.windowDurationMins < MIN_PACE_WINDOW_MINS) {
    return undefined;
  }
  return usageWindowElapsedPercent(window, nowMs);
}

/** "the week", "the day", "the 5-hour window": the span a pace mark measures. */
function formatUsageWindowSpan(minutes: number): string {
  if (minutes === 10_080) return "the week";
  if (minutes === 1_440) return "the day";
  if (minutes % 1_440 === 0) return `the ${minutes / 1_440}-day window`;
  if (minutes % 60 === 0) return `the ${minutes / 60}-hour window`;
  return `the ${minutes}-minute window`;
}

/** "44% of the week has passed", for the pace mark's hover text. */
function formatUsagePaceDetail(
  window: Pick<ServerProviderUsageWindow, "windowDurationMins">,
  elapsedPercent: number | undefined,
): string | null {
  const minutes = window.windowDurationMins;
  if (elapsedPercent === undefined || minutes === undefined) return null;
  return `${Math.round(elapsedPercent)}% of ${formatUsageWindowSpan(minutes)} has passed`;
}

/** The pace fields of a window presentation: both or neither. */
function usagePaceFields(
  window: Pick<ServerProviderUsageWindow, "windowDurationMins">,
  elapsedPercent: number | undefined,
): Pick<ProviderAccountUsageWindowPresentation, "elapsedPercent" | "paceDetail"> {
  const paceDetail = formatUsagePaceDetail(window, elapsedPercent);
  return elapsedPercent !== undefined && paceDetail !== null ? { elapsedPercent, paceDetail } : {};
}

/**
 * How far usage may run past the pace mark before the detail says so, in
 * percentage points. Keeps a bar sitting on its mark, or one early in its
 * window, from flagging every small burst.
 */
const AHEAD_OF_PACE_MARGIN_PERCENT = 5;

/** "ahead of pace" when usage is on track to run out before the reset. */
function formatPaceDetail(usedPercent: number, elapsedPercent: number | undefined): string | null {
  if (elapsedPercent === undefined) return null;
  return usedPercent - elapsedPercent >= AHEAD_OF_PACE_MARGIN_PERCENT ? "ahead of pace" : null;
}

function formatResetDetail(resetsAt: number | undefined, nowMs: number): string | null {
  const resetMs = normalizeResetTimestampMs(resetsAt);
  if (resetMs === null) return null;

  const remaining = formatRemainingDuration(resetMs, nowMs);
  return remaining === null ? "resets now" : `resets in ${remaining}`;
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

/**
 * The one usage figure a compact surface shows for an account: its spend
 * control when it has one, else whichever window is closest to its limit, so
 * an account with an exhausted 5-hour window never reads as having room.
 */
export function headlineUsageMeter(
  usage: Pick<ProviderAccountUsagePresentation, "spendControl" | "windows">,
): ProviderAccountUsageSpendControlPresentation | ProviderAccountUsageWindowPresentation | null {
  if (usage.spendControl) return usage.spendControl;
  return usage.windows.reduce<ProviderAccountUsageWindowPresentation | null>(
    (worst, window) => (worst === null || window.usedPercent > worst.usedPercent ? window : worst),
    null,
  );
}

/** One line of a compact usage stack: a short label and how full that limit is. */
export interface ProviderUsageMeterLine {
  readonly key: string;
  readonly label: string;
  /** "29% used · resets in 2h 5m", for the hover. */
  readonly detail: string;
  readonly usedPercent: number;
  readonly warning: boolean;
  /** Covers the whole account (spend control, 5h, Weekly) rather than one model. */
  readonly accountWide: boolean;
}

/** How many lines a compact usage stack shows before it starts dropping the emptiest. */
export const COMPACT_USAGE_METER_LIMIT = 4;

/**
 * Every limit an account reports, for a surface with room for a short stack
 * (a Providers row): the spend control when there is one, then each window in
 * the provider's order. Where `headlineUsageMeter` answers "how close am I to
 * any limit", this answers "where do I stand on each one".
 *
 * Past `limit` lines the emptiest scoped ones are dropped. The account-wide
 * lines (spend control, 5h, Weekly) always stay: a reader expects to find them.
 */
export function compactUsageMeters(
  usage: Pick<ProviderAccountUsagePresentation, "spendControl" | "windows">,
  limit: number = COMPACT_USAGE_METER_LIMIT,
): ReadonlyArray<ProviderUsageMeterLine> {
  // A short label two windows share ("Gemini" for its 5h and weekly limits)
  // keeps its period, so the lines stay apart.
  const shortLabelCounts = new Map<string, number>();
  for (const window of usage.windows) {
    if (window.shortLabel === undefined) continue;
    shortLabelCounts.set(window.shortLabel, (shortLabelCounts.get(window.shortLabel) ?? 0) + 1);
  }
  const lines: ReadonlyArray<ProviderUsageMeterLine> = [
    ...(usage.spendControl
      ? [
          {
            key: "spend-control",
            label: usage.spendControl.label,
            detail: usage.spendControl.detail,
            usedPercent: usage.spendControl.usedPercent,
            warning: usage.spendControl.warning,
            accountWide: true,
          },
        ]
      : []),
    ...usage.windows.map((window) => ({
      key: window.key,
      label:
        window.shortLabel !== undefined && shortLabelCounts.get(window.shortLabel) === 1
          ? window.shortLabel
          : window.label,
      detail: window.detail,
      usedPercent: window.usedPercent,
      warning: window.warning,
      accountWide: window.key === "primary" || window.key === "secondary",
    })),
  ];
  if (lines.length <= limit) return lines;
  const kept = new Set(lines.filter((line) => line.accountWide));
  const scopedFullestFirst = lines
    .filter((line) => !line.accountWide)
    .toSorted((a, b) => b.usedPercent - a.usedPercent);
  for (const line of scopedFullestFirst) {
    if (kept.size >= limit) break;
    kept.add(line);
  }
  return lines.filter((line) => kept.has(line));
}

/** Usage at or above this is "near limit": bars turn amber and the composer dot appears. */
export const USAGE_WARNING_THRESHOLD_PERCENT = 75;

/**
 * Fill color for a usage meter. Below the warning threshold the caller keeps
 * its neutral fill (`undefined`). From the threshold up, the color blends from
 * the warning amber into the destructive red, fully red at 100%. A warning
 * raised below the threshold (provider-reported severity) stays amber.
 */
export function usageMeterColor(usedPercent: number, warning: boolean): string | undefined {
  if (!warning) return undefined;
  const span = 100 - USAGE_WARNING_THRESHOLD_PERCENT;
  const progress = Math.max(0, Math.min(1, (usedPercent - USAGE_WARNING_THRESHOLD_PERCENT) / span));
  const redPercent = Math.round(progress * 100);
  return `color-mix(in oklab, var(--color-destructive) ${redPercent}%, var(--color-warning))`;
}

function hasReachedUsageWindow(window: ServerProviderUsageWindow): boolean {
  return window.usedPercent >= 100 || window.remainingPercent <= 0;
}

function hasReachedSpendControlLimit(limit: ServerProviderSpendControlLimit): boolean {
  return limit.remainingPercent <= 0;
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

function formatBlockingLimitLabel(label: string): string {
  return label.toLowerCase();
}

function formatBlockedByLimitDetail(blockingLimitLabels: ReadonlyArray<string>): string | null {
  const uniqueLabels = [...new Set(blockingLimitLabels)]
    .map(formatBlockingLimitLabel)
    .filter((label) => label.length > 0);
  if (uniqueLabels.length === 0) return null;
  if (uniqueLabels.length === 1) return `blocked by ${uniqueLabels[0]} limit`;
  if (uniqueLabels.length === 2) {
    return `blocked by ${uniqueLabels[0]} and ${uniqueLabels[1]} limits`;
  }
  return `blocked by ${uniqueLabels.length} limits`;
}

function formatUsageWindowPresentation(
  key: ProviderAccountUsageWindowPresentation["key"],
  window: ServerProviderUsageWindow,
  label: string,
  reachedLimit: boolean,
  blockingLimitLabels: ReadonlyArray<string>,
  nowMs: number,
): ProviderAccountUsageWindowPresentation {
  const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
  const remainingPercent = Math.max(0, Math.min(100, window.remainingPercent));
  const windowReachedLimit = reachedLimit || usedPercent >= 100 || remainingPercent <= 0;
  const resetDetail = formatResetDetail(window.resetsAt, nowMs);
  const blockedByLimitDetail = windowReachedLimit
    ? null
    : formatBlockedByLimitDetail(blockingLimitLabels);
  const elapsedPercent = usageWindowPaceElapsedPercent(window, nowMs);
  const detailParts = [
    windowReachedLimit ? "limit reached" : `${usedPercent}% used`,
    // Pace stops mattering once this limit or another one is the blocker.
    windowReachedLimit || blockedByLimitDetail
      ? null
      : formatPaceDetail(usedPercent, elapsedPercent),
    blockedByLimitDetail,
    resetDetail,
    formatReadingAgeDetail(window.checkedAt, nowMs),
  ].filter((part): part is string => Boolean(part));

  return {
    key,
    label,
    detail: detailParts.join(" · "),
    usedPercent,
    remainingPercent,
    reachedLimit: windowReachedLimit,
    warning: windowReachedLimit || usedPercent >= USAGE_WARNING_THRESHOLD_PERCENT,
    ...usagePaceFields(window, elapsedPercent),
  };
}

/**
 * Scoped windows only constrain part of the account's usage (e.g. one
 * model's weekly cap), so a reached scoped limit never marks sibling
 * windows as blocked. Provider-reported severity feeds the warning signal
 * ahead of the local threshold.
 */
function formatScopedUsageWindowPresentation(
  window: ServerProviderScopedUsageWindow,
  index: number,
  nowMs: number,
): ProviderAccountUsageWindowPresentation {
  const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
  const remainingPercent = Math.max(0, Math.min(100, window.remainingPercent));
  const reachedLimit = usedPercent >= 100 || remainingPercent <= 0;
  const severityWarning = window.severity !== undefined && window.severity !== "normal";
  const resetDetail = formatResetDetail(window.resetsAt, nowMs);
  const durationLabel = formatUsageWindowDurationLabel(window, "");
  const elapsedPercent = usageWindowPaceElapsedPercent(window, nowMs);
  const detailParts = [
    reachedLimit ? "limit reached" : `${usedPercent}% used`,
    reachedLimit ? null : formatPaceDetail(usedPercent, elapsedPercent),
    resetDetail,
    formatReadingAgeDetail(window.checkedAt, nowMs),
  ].filter((part): part is string => Boolean(part));

  return {
    key: `scoped-${index}`,
    label: durationLabel
      ? `${window.scopeLabel} (${durationLabel.toLowerCase()})`
      : window.scopeLabel,
    ...(durationLabel ? { shortLabel: window.scopeLabel } : {}),
    detail: detailParts.join(" · "),
    usedPercent,
    remainingPercent,
    reachedLimit,
    warning: reachedLimit || severityWarning || usedPercent >= USAGE_WARNING_THRESHOLD_PERCENT,
    ...usagePaceFields(window, elapsedPercent),
    scope: {
      name: window.scopeLabel,
      ...(window.scopeModels ? { models: window.scopeModels } : {}),
      ...(window.scopeExcludes ? { excludes: window.scopeExcludes } : {}),
      period: durationLabel || null,
      resetDetail,
    },
  };
}

function formatSpendControlPresentation(
  limit: ServerProviderSpendControlLimit,
  reachedLimit: boolean,
  blockingLimitLabels: ReadonlyArray<string>,
  nowMs: number,
): ProviderAccountUsageSpendControlPresentation {
  const remainingPercent = Math.max(0, Math.min(100, limit.remainingPercent));
  const usedPercent = Math.max(0, 100 - remainingPercent);
  const spendControlReachedLimit = reachedLimit || usedPercent >= 100 || remainingPercent <= 0;
  const resetDetail = formatResetDetail(limit.resetsAt, nowMs);
  const blockedByLimitDetail = spendControlReachedLimit
    ? null
    : formatBlockedByLimitDetail(blockingLimitLabels);
  const detailParts = [
    `${limit.used} used of ${limit.limit}`,
    spendControlReachedLimit ? "limit reached" : `${usedPercent}% used`,
    blockedByLimitDetail,
    resetDetail,
  ].filter((part): part is string => Boolean(part));

  return {
    label: "Monthly",
    detail: detailParts.join(" - "),
    usedPercent,
    remainingPercent,
    reachedLimit: spendControlReachedLimit,
    warning: spendControlReachedLimit || usedPercent >= USAGE_WARNING_THRESHOLD_PERCENT,
  };
}

function formatResetCreditsPresentation(
  usage: ServerProviderAccountUsage,
  nowMs: number,
): ProviderAccountUsageResetCreditsPresentation | undefined {
  const availableCount =
    usage.rateLimitResetCredits?.availableCount ??
    (usage.source === "codex-rate-limits" ? 0 : undefined);
  if (availableCount === undefined || !Number.isInteger(availableCount) || availableCount < 0) {
    return undefined;
  }

  const expirationUrgency = providerRateLimitResetCreditsExpirationUrgency(
    usage.rateLimitResetCredits?.credits,
    nowMs,
  );
  const soonestExpirationMs = soonestUsableResetCreditExpirationMs(
    usage.rateLimitResetCredits?.credits,
    nowMs,
  );
  const nextExpiration =
    soonestExpirationMs === null ? null : formatRemainingDuration(soonestExpirationMs, nowMs);
  return {
    availableCount,
    label: availableCount === 1 ? "1 reset available" : `${availableCount} resets available`,
    shortLabel: availableCount <= 0 ? "None available" : `${availableCount} available`,
    detail: nextExpiration ? `next expires in ${nextExpiration}` : "expiration dates unavailable",
    ...(expirationUrgency ? { expirationUrgency } : {}),
  };
}

/** The smallest change each size of token count shows, matching the format below. */
function tokenCountDisplayStep(value: number): number {
  if (value < 1_000) return 1;
  if (value < 10_000) return 100;
  if (value < 1_000_000) return 1_000;
  if (value < 1_000_000_000) return 100_000;
  return value < 10_000_000_000 ? 10_000_000 : 100_000_000;
}

/**
 * A token count for display. `roundDown` is for a floor ("at least"): the
 * shown number must not exceed what was counted.
 */
export function formatProviderTokenCount(
  rawValue: number | undefined,
  options?: { readonly roundDown?: boolean },
): string | null {
  if (rawValue === undefined || !Number.isFinite(rawValue) || rawValue < 0) return null;
  const value = options?.roundDown
    ? Math.floor(rawValue / tokenCountDisplayStep(rawValue)) * tokenCountDisplayStep(rawValue)
    : rawValue;
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

  const reportedLifetimeTokens = usage.summary.lifetimeTokens;
  const bucketLifetimeTokens = usage.dailyBuckets.reduce(
    (total, bucket) => total + bucket.tokens,
    0,
  );
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
    summary.push({
      key: "lifetimeTokens",
      label: usage.scope === "local" ? "Tracked tokens" : "Lifetime tokens",
      value: lifetimeTokens,
    });
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
    label: usage.scope === "local" ? "Local token activity" : "Token history",
    checkedAt: usage.checkedAt,
    scope: usage.scope ?? "account",
    ...(usage.coverageStartDate ? { coverageStartDate: usage.coverageStartDate } : {}),
    ...(usage.coverageEndDate ? { coverageEndDate: usage.coverageEndDate } : {}),
    completeLifetimeHistory:
      usage.completeLifetimeHistory ??
      (reportedLifetimeTokens !== undefined && bucketLifetimeTokens === reportedLifetimeTokens),
    summary,
    buckets,
  };
}

const PROVIDER_USAGE_SOURCE_LABELS: Record<ServerProviderAccountUsage["source"], string> = {
  "codex-rate-limits": "Codex usage",
  "claude-oauth-usage": "Claude usage",
  "muse-subscription-usage": "Muse Code usage",
  "grok-billing": "Grok usage",
};

export function deriveProviderAccountUsagePresentation(
  usage: ServerProviderAccountUsage | undefined,
  nowMs: number = Date.now(),
): ProviderAccountUsagePresentation | null {
  if (!usage || !(usage.source in PROVIDER_USAGE_SOURCE_LABELS)) return null;

  const resetCredits = formatResetCreditsPresentation(usage, nowMs);
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
  const windowInputs = [
    ...(limit.primary
      ? [
          {
            key: "primary" as const,
            label: formatUsageWindowDurationLabel(limit.primary, "5h"),
            window: limit.primary,
          },
        ]
      : []),
    ...(limit.secondary
      ? [
          {
            key: "secondary" as const,
            label: formatUsageWindowDurationLabel(limit.secondary, "Weekly"),
            window: limit.secondary,
          },
        ]
      : []),
  ];
  const reachedLimitLabels = [
    ...windowInputs
      .filter((input) => hasReachedUsageWindow(input.window))
      .map((input) => input.label),
    ...(limit.individualLimit && hasReachedSpendControlLimit(limit.individualLimit)
      ? ["Monthly"]
      : []),
  ];
  const useProviderLevelLimitFallback = reachedLimit && reachedLimitLabels.length === 0;
  const windows = [
    ...windowInputs.map((input) => {
      const windowReachedLimit = hasReachedUsageWindow(input.window);
      return formatUsageWindowPresentation(
        input.key,
        input.window,
        input.label,
        useProviderLevelLimitFallback || windowReachedLimit,
        windowReachedLimit ? [] : reachedLimitLabels,
        nowMs,
      );
    }),
    ...(limit.scoped ?? []).map((scopedWindow, index) =>
      formatScopedUsageWindowPresentation(scopedWindow, index, nowMs),
    ),
  ];
  const spendControlReachedLimit = limit.individualLimit
    ? hasReachedSpendControlLimit(limit.individualLimit)
    : false;
  const spendControl = limit.individualLimit
    ? formatSpendControlPresentation(
        limit.individualLimit,
        useProviderLevelLimitFallback || spendControlReachedLimit,
        spendControlReachedLimit ? [] : reachedLimitLabels,
        nowMs,
      )
    : undefined;
  if (windows.length === 0 && !spendControl && !resetCredits && !tokenUsage) return null;
  const externalResets = providerExternalResetsLink(usage);

  return {
    label: limit.limitName ?? PROVIDER_USAGE_SOURCE_LABELS[usage.source],
    ...(spendControl ? { spendControl } : {}),
    ...(resetCredits ? { resetCredits } : {}),
    ...(externalResets ? { externalResets } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    windows,
    reachedLimit:
      reachedLimit ||
      Boolean(spendControl?.reachedLimit) ||
      windows.some((window) => window.reachedLimit),
  };
}

function hasStaleUsageReading(
  usage: ServerProviderAccountUsage | undefined,
  nowMs: number,
): boolean {
  const limit = usage ? selectProviderUsageLimit(usage) : null;
  if (!limit) return false;
  return [limit.primary, limit.secondary, ...(limit.scoped ?? [])].some(
    (window) => window !== undefined && isUsageReadingStale(window.checkedAt, nowMs),
  );
}

/**
 * What to say about a Claude usage check that produced no numbers. Sign-in is
 * only offered when Claude reports the sign-in gone; a rate limit or a failed
 * request fixes itself, and stays quiet while the kept numbers are recent.
 * API-key auth has no subscription usage to speak of.
 */
function deriveClaudeUsageNotice(
  provider: ProviderAccountUsagePresentationProvider,
  hasNumbers: boolean,
  hasStaleReading: boolean,
): ProviderAccountUsageNotice | undefined {
  if (provider.driver !== "claudeAgent" || provider.auth.type?.toLowerCase() === "apikey") {
    return undefined;
  }
  const usage = provider.auth.capabilities?.usage;
  if (usage === undefined) {
    // A sign-in whose server said nothing about usage either way: with no
    // numbers to show, say they are missing rather than show nothing.
    return provider.auth.status === "authenticated" && !hasNumbers
      ? { signIn: false, text: "Plan limits can't be read right now." }
      : undefined;
  }
  if (usage.status !== "unavailable") return undefined;
  if (usage.reason === "signed_out") {
    return {
      signIn: true,
      text: hasNumbers
        ? "Claude is signed out. Usage updates only when you chat."
        : "Claude is signed out. Sign in to see usage.",
    };
  }
  if (hasNumbers && !hasStaleReading) return undefined;
  switch (usage.reason) {
    case "rate_limited":
      return { signIn: false, text: "Claude is limiting usage checks. Trying again soon." };
    case "unreachable":
      return { signIn: false, text: "Couldn't check usage just now. Trying again soon." };
    default:
      // A server that gives no reason still gives its own words for it.
      return hasNumbers
        ? undefined
        : { signIn: false, text: usage.detail ?? "Plan limits can't be read right now." };
  }
}

/**
 * What another provider's server says about its own usage check, in its own
 * words (Antigravity: "start a chat to refresh"). A failed read stays quiet
 * while the kept numbers are recent; anything else is said either way.
 */
function deriveReportedUsageNotice(
  provider: ProviderAccountUsagePresentationProvider,
  hasNumbers: boolean,
  hasStaleReading: boolean,
): ProviderAccountUsageNotice | undefined {
  if (provider.driver === "claudeAgent" || provider.auth.status !== "authenticated") {
    return undefined;
  }
  const usage = provider.auth.capabilities?.usage;
  if (usage?.status !== "unavailable" || usage.detail === undefined) return undefined;
  if (usage.reason === "unreachable" && hasNumbers && !hasStaleReading) return undefined;
  return { signIn: false, text: usage.detail };
}

/** What a usage surface is titled when the provider has a notice and no reading. */
function providerUsageLabel(provider: ProviderAccountUsagePresentationProvider): string {
  switch (provider.driver) {
    case "claudeAgent":
      return PROVIDER_USAGE_SOURCE_LABELS["claude-oauth-usage"];
    case "antigravity":
      return "Antigravity usage";
    default:
      return "Plan usage";
  }
}

/**
 * The usage presentation for a provider as a whole, not just its usage
 * payload: a Claude subscription whose usage check produced no numbers, or a
 * provider whose server explains its own (Antigravity), comes back with a
 * `notice` (keeping the numbers it has, and any local token
 * history) instead of as nothing, so its surfaces can say what is wrong. A
 * notice with no windows means there is nothing to draw: an empty meter
 * would read as "0% used".
 */
export function deriveProviderAccountUsagePresentationForProvider(
  provider: ProviderAccountUsagePresentationProvider | null | undefined,
  nowMs: number = Date.now(),
): ProviderAccountUsagePresentation | null {
  const presentation = deriveProviderAccountUsagePresentation(provider?.accountUsage, nowMs);
  if (!provider) return presentation;
  const hasNumbers =
    presentation !== null &&
    (presentation.windows.length > 0 || presentation.spendControl !== undefined);
  const hasStaleReading = hasStaleUsageReading(provider.accountUsage, nowMs);
  const notice =
    deriveClaudeUsageNotice(provider, hasNumbers, hasStaleReading) ??
    deriveReportedUsageNotice(provider, hasNumbers, hasStaleReading);
  if (!notice) return presentation;
  return presentation
    ? { ...presentation, notice }
    : {
        label: providerUsageLabel(provider),
        windows: [],
        reachedLimit: false,
        notice,
      };
}

/**
 * True when any tracked window or spend control is at/near its cap — used
 * by ambient indicators (composer meter dot) that should only light up when
 * the user is about to be throttled.
 */
export function isProviderUsageNearLimit(
  presentation: ProviderAccountUsagePresentation | null,
  options: {
    /**
     * False: only limits on the whole account count, never one model's own
     * cap. The model picker's dot on a provider uses this; the model's own
     * limit shows on its row (modelOwnUsageLimit).
     */
    readonly modelLimits?: boolean;
  } = {},
): boolean {
  if (!presentation) return false;
  if (presentation.spendControl?.warning) return true;
  // `reachedLimit` also counts a model's own limit, so it decides only when
  // those count too; a window reached is a window in warning either way.
  if (options.modelLimits !== false) {
    return presentation.reachedLimit || presentation.windows.some((window) => window.warning);
  }
  // Reached with no model's own limit reached: the account itself is out
  // (Codex can say so with no windows at all).
  const modelLimitReached = presentation.windows.some(
    (window) => window.scope !== undefined && window.reachedLimit,
  );
  if (presentation.reachedLimit && !modelLimitReached) return true;
  return presentation.windows.some((window) => window.scope === undefined && window.warning);
}

/**
 * Color for the ambient near-limit indicator: the hottest meter in the
 * presentation, fully red once any limit is reached. `undefined` when the
 * indicator should not show.
 */
export function providerUsageNearLimitColor(
  presentation: ProviderAccountUsagePresentation | null,
): string | undefined {
  if (!presentation || !isProviderUsageNearLimit(presentation)) return undefined;
  if (presentation.reachedLimit) return usageMeterColor(100, true);
  const hottestPercent = [
    ...(presentation.spendControl ? [presentation.spendControl] : []),
    ...presentation.windows,
  ]
    .filter((meter) => meter.warning)
    .reduce((max, meter) => Math.max(max, meter.usedPercent), 0);
  return usageMeterColor(hottestPercent, true);
}

/**
 * The limit a model has of its own, if the account reports one: a window
 * whose scope holds the model's name (`usageScopeHoldsModel`). The fullest
 * applies when several do.
 */
export function modelOwnUsageLimit(
  usage: Pick<ProviderAccountUsagePresentation, "windows"> | null | undefined,
  modelName: string,
): ProviderAccountUsageWindowPresentation | null {
  if (!usage) return null;
  return usage.windows.reduce<ProviderAccountUsageWindowPresentation | null>((fullest, window) => {
    if (window.scope === undefined || !usageScopeHoldsModel(window.scope, modelName)) {
      return fullest;
    }
    return fullest === null || window.usedPercent > fullest.usedPercent ? window : fullest;
  }, null);
}

/** "Weekly" → "week", for "64% of week". Periods with no such word stay as they are. */
const PERIOD_NOUNS: Readonly<Record<string, string>> = {
  Weekly: "week",
  Daily: "day",
  Monthly: "month",
};

/**
 * What a model's row says about its own limit: "40% of week", in the row's
 * grey until the warning threshold, then amber; "Limit · resets in 3d 16h",
 * in red, once it is reached. The hover has the whole reading.
 */
export function modelUsageLimitLabel(window: ProviderAccountUsageWindowPresentation): {
  readonly text: string;
  readonly tone: "normal" | "warning" | "reached";
  readonly title: string;
} {
  const percent = Math.round(window.usedPercent);
  const period = window.scope?.period ?? null;
  const reset = window.scope?.resetDetail ?? null;
  return {
    text: window.reachedLimit
      ? reset
        ? `Limit · ${reset}`
        : "Limit reached"
      : period
        ? `${percent}% of ${PERIOD_NOUNS[period] ?? period}`
        : `${percent}% used`,
    tone: window.reachedLimit ? "reached" : window.warning ? "warning" : "normal",
    title: `${window.label} · ${window.detail}`,
  };
}
