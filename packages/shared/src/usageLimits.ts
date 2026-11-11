/**
 * Plan usage limits: whether an account's usage reading says it is out of
 * room, and until when. Used by the drivers (a limit's reset time when the
 * agent didn't name one), the server's "Continue at reset" (has the limit
 * really reset?) and the client (which other accounts still have room).
 *
 * Only plan-wide windows count. A window scoped to one model (Claude's weekly
 * Opus cap) never blocks the account as a whole.
 *
 * @module usageLimits
 */
import type {
  OrchestrationUsageLimitWindow,
  RuntimeUsageLimit,
  ServerProvider,
  ServerProviderAccountUsage,
  ServerProviderUsageWindow,
} from "@threadlines/contracts";

/** What a continuing thread sends once its usage limit resets. */
export const CONTINUE_AT_RESET_MESSAGE = "Continue where you left off.";

/** How long after the reset time the thread continues, so the agent's own clock has moved on too. */
export const CONTINUE_AT_RESET_DELAY_MS = 60_000;

/** When a thread waiting for `resetsAtMs` continues. */
export function continueAtResetTimeMs(resetsAtMs: number): number {
  return resetsAtMs + CONTINUE_AT_RESET_DELAY_MS;
}

/** Usage readings carry reset times in epoch seconds or milliseconds. */
export function usageResetTimeMs(resetsAt: number | undefined): number | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= 0) return undefined;
  return resetsAt < 10_000_000_000 ? resetsAt * 1000 : resetsAt;
}

/** A window's length as the limit people know it by: up to a day is the session, a week the weekly one. */
export function usageLimitWindowFromMinutes(
  minutes: number | undefined,
): Exclude<OrchestrationUsageLimitWindow, "other"> | undefined {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return undefined;
  if (minutes <= 24 * 60) return "session";
  if (minutes >= 6 * 24 * 60) return "weekly";
  return undefined;
}

export type AccountUsageBlock =
  /** The reading says the plan's usage is spent; `resetsAtMs` is the latest reset among the spent windows, when known. */
  | {
      readonly state: "blocked";
      readonly resetsAtMs: number | null;
      readonly window: Exclude<OrchestrationUsageLimitWindow, "other"> | undefined;
    }
  /** The reading has numbers and none of its plan-wide windows is spent. */
  | { readonly state: "open" }
  /** No reading to go by. */
  | { readonly state: "unknown" };

function isUsedUpTo(
  window: Pick<ServerProviderUsageWindow, "usedPercent" | "remainingPercent">,
  percent: number,
): boolean {
  return window.usedPercent >= percent || window.remainingPercent <= 100 - percent;
}

/**
 * Whether an account's usage reading says it is out of room at `nowMs`. A
 * spent window whose reset time has passed no longer counts: the reading is
 * older than the reset. Codex's `ordinaryUsageAllowed: false` blocks on the
 * backend's word even when no window looks spent.
 */
export function readAccountUsageBlock(
  accountUsage: ServerProviderAccountUsage | undefined,
  nowMs: number,
): AccountUsageBlock {
  return readAccountUsageBlockAt(accountUsage, nowMs, 100);
}

/**
 * Whether an account is close enough to a limit (`percent` of a plan-wide
 * window used, or out of room) that extras which spend usage, like a
 * suggested next message, should wait: by `readAccountUsageBlock`'s rules.
 * False with no reading to go by.
 */
export function isAccountUsageNearLimit(
  accountUsage: ServerProviderAccountUsage | undefined,
  nowMs: number,
  percent: number,
): boolean {
  return readAccountUsageBlockAt(accountUsage, nowMs, percent).state === "blocked";
}

function readAccountUsageBlockAt(
  accountUsage: ServerProviderAccountUsage | undefined,
  nowMs: number,
  spentAtPercent: number,
): AccountUsageBlock {
  if (accountUsage === undefined) return { state: "unknown" };
  let blocked = false;
  let resetsAtMs: number | null = null;
  let window: Exclude<OrchestrationUsageLimitWindow, "other"> | undefined;
  let sawWindow = false;
  for (const limit of accountUsage.limits) {
    for (const candidate of [limit.primary, limit.secondary]) {
      if (candidate === undefined) continue;
      sawWindow = true;
      if (!isUsedUpTo(candidate, spentAtPercent)) continue;
      const resetMs = usageResetTimeMs(candidate.resetsAt);
      if (resetMs !== undefined && resetMs <= nowMs) continue;
      blocked = true;
      if (resetMs !== undefined && (resetsAtMs === null || resetMs > resetsAtMs)) {
        resetsAtMs = resetMs;
        window = usageLimitWindowFromMinutes(candidate.windowDurationMins);
      }
    }
  }
  if (accountUsage.ordinaryUsageAllowed === false) blocked = true;
  if (blocked) return { state: "blocked", resetsAtMs, window };
  if (sawWindow || accountUsage.ordinaryUsageAllowed === true) return { state: "open" };
  return { state: "unknown" };
}

/**
 * `readAccountUsageBlock` for a provider instance. Usage read for another
 * account than the one it chats as (`auth.usageEmail`) says nothing about
 * its own limit.
 */
export function readProviderUsageBlock(
  provider: Pick<ServerProvider, "auth" | "accountUsage">,
  nowMs: number,
): AccountUsageBlock {
  if (provider.auth.usageEmail !== undefined && provider.auth.email !== undefined) {
    return { state: "unknown" };
  }
  return readAccountUsageBlock(provider.accountUsage, nowMs);
}

/** One window of a provider instance's usage reading: the plan's, or one model's own. */
export interface ProviderUsageWindowReading {
  /**
   * Which window it is, the same from one reading to the next. Two windows a
   * provider doesn't tell apart share a key.
   */
  readonly key: string;
  /** Used up, and not yet reset at the time asked about. */
  readonly spent: boolean;
  readonly resetsAtMs: number | undefined;
  /** When this window was last read: a reading can carry a window over from an earlier one. */
  readonly readAtMs: number;
}

/**
 * Every window on a provider instance's usage reading, one model's own
 * windows included. `readProviderUsageBlock` says whether the account as a
 * whole is out of room; this is for following one limit from reading to
 * reading, whichever window it is. Null when there is no reading of the
 * account the instance chats as.
 */
export function listProviderUsageWindows(
  provider: Pick<ServerProvider, "auth" | "accountUsage">,
  nowMs: number,
): ReadonlyArray<ProviderUsageWindowReading> | null {
  const accountUsage = provider.accountUsage;
  if (
    accountUsage === undefined ||
    (provider.auth.usageEmail !== undefined && provider.auth.email !== undefined)
  ) {
    return null;
  }
  const windows: Array<ProviderUsageWindowReading> = [];
  const add = (
    key: string,
    window: Pick<
      ServerProviderUsageWindow,
      "usedPercent" | "remainingPercent" | "resetsAt" | "checkedAt"
    >,
  ) => {
    const resetsAtMs = usageResetTimeMs(window.resetsAt);
    const readAtMs = Date.parse(window.checkedAt ?? accountUsage.checkedAt);
    windows.push({
      key,
      spent: isUsedUpTo(window, 100) && (resetsAtMs === undefined || resetsAtMs > nowMs),
      resetsAtMs,
      readAtMs: Number.isFinite(readAtMs) ? readAtMs : 0,
    });
  };
  accountUsage.limits.forEach((limit, index) => {
    const limitKey = limit.limitId ?? String(index);
    if (limit.primary) add(`${limitKey}:primary`, limit.primary);
    if (limit.secondary) add(`${limitKey}:secondary`, limit.secondary);
    // One label can name a model's session, daily and weekly windows at once.
    for (const scoped of limit.scoped ?? []) {
      add(`${limitKey}:scoped:${scoped.scopeLabel}:${scoped.windowDurationMins ?? ""}`, scoped);
    }
  });
  return windows;
}

/**
 * The limit an account's reading says it is stopped on, as a failed turn
 * reports it: for an agent that refused a turn without naming the reset time.
 * Undefined when the reading shows no spent window with a reset ahead.
 */
export function usageLimitFromAccountUsage(
  accountUsage: ServerProviderAccountUsage | undefined,
  nowMs: number,
): RuntimeUsageLimit | undefined {
  const block = readAccountUsageBlock(accountUsage, nowMs);
  if (block.state !== "blocked" || block.resetsAtMs === null) return undefined;
  return {
    ...(block.window ? { window: block.window } : {}),
    resetsAt: new Date(block.resetsAtMs).toISOString(),
  };
}
