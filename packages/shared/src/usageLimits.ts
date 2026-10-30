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

function isSpent(window: ServerProviderUsageWindow): boolean {
  return window.usedPercent >= 100 || window.remainingPercent <= 0;
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
  if (accountUsage === undefined) return { state: "unknown" };
  let blocked = false;
  let resetsAtMs: number | null = null;
  let window: Exclude<OrchestrationUsageLimitWindow, "other"> | undefined;
  let sawWindow = false;
  for (const limit of accountUsage.limits) {
    for (const candidate of [limit.primary, limit.secondary]) {
      if (candidate === undefined) continue;
      sawWindow = true;
      if (!isSpent(candidate)) continue;
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
