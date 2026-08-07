/**
 * The composer notice for a turn whose startup is running long.
 *
 * @module sessionStartupNotice
 */
import type { ServerProvider } from "@threadlines/contracts";
import { useEffect, useMemo, useState } from "react";

import type { ComposerNotice } from "./composerNotices";
import { StatusNoticeActionButtons, useProviderStatusRefresh } from "./statusNotice";

export const SESSION_STARTUP_SLOW_NOTICE_DELAY_MS = 30_000;

const SESSION_STARTUP_SLOW_MESSAGE =
  "Preparing this turn is taking longer than usual. Refresh provider status or open diagnostics if it stays stuck.";

export function getSessionStartupNoticeDelayMs(input: {
  readonly isSessionStarting: boolean;
  readonly startedAt: string | null;
  readonly nowMs: number;
}): number | null {
  if (!input.isSessionStarting || input.startedAt === null) {
    return null;
  }
  const startedAtMs = Date.parse(input.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return 0;
  }
  const elapsedMs = Math.max(0, input.nowMs - startedAtMs);
  return Math.max(0, SESSION_STARTUP_SLOW_NOTICE_DELAY_MS - elapsedMs);
}

export function shouldShowSessionStartupNotice(input: {
  readonly isSessionStarting: boolean;
  readonly startedAt: string | null;
  readonly nowMs: number;
}): boolean {
  return getSessionStartupNoticeDelayMs(input) === 0;
}

/**
 * `suppressed` stays even though the dock could rank this notice below the
 * others: a provider-status or turn-error row already names the reason startup
 * is stuck, so adding "1 more" for a vaguer restatement of it only makes the
 * user open the stack to learn nothing.
 */
export function useSessionStartupNotice(input: {
  readonly isSessionStarting: boolean;
  readonly startedAt: string | null;
  readonly suppressed: boolean;
  readonly providerStatus: ServerProvider | null;
}): ComposerNotice | null {
  const { isSessionStarting, providerStatus, startedAt, suppressed } = input;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { isRefreshing, refreshError, refreshProvider } = useProviderStatusRefresh(
    providerStatus?.instanceId ?? null,
  );

  useEffect(() => {
    setNowMs(Date.now());
  }, [isSessionStarting, startedAt]);

  useEffect(() => {
    if (suppressed) {
      return;
    }
    const remainingMs = getSessionStartupNoticeDelayMs({ isSessionStarting, nowMs, startedAt });
    if (remainingMs === null || remainingMs <= 0) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setNowMs(Date.now());
    }, remainingMs + 50);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isSessionStarting, nowMs, startedAt, suppressed]);

  const visible =
    !suppressed && shouldShowSessionStartupNotice({ isSessionStarting, nowMs, startedAt });

  return useMemo(() => {
    if (!visible) {
      return null;
    }
    return {
      id: "session-startup",
      severity: "warning",
      lead: "Turn startup",
      detail: refreshError
        ? `${SESSION_STARTUP_SLOW_MESSAGE} ${refreshError}`
        : SESSION_STARTUP_SLOW_MESSAGE,
      actions: (
        <StatusNoticeActionButtons
          variant="ghost"
          isRefreshing={isRefreshing}
          onRefresh={providerStatus ? refreshProvider : null}
        />
      ),
    } satisfies ComposerNotice;
  }, [isRefreshing, providerStatus, refreshError, refreshProvider, visible]);
}
