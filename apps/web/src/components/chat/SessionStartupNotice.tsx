import type { ServerProvider } from "@threadlines/contracts";
import { memo, useEffect, useState } from "react";
import {
  CompactStatusNoticeRow,
  StatusNoticeActionButtons,
  useProviderStatusRefresh,
} from "./statusNotice";

export const SESSION_STARTUP_SLOW_NOTICE_DELAY_MS = 30_000;

const SESSION_STARTUP_SLOW_MESSAGE =
  "Starting this session is taking longer than usual. Refresh provider status or open diagnostics if it stays stuck.";

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

export const SessionStartupNotice = memo(function SessionStartupNotice({
  isSessionStarting,
  startedAt,
  suppressed = false,
  providerStatus,
}: {
  isSessionStarting: boolean;
  startedAt: string | null;
  suppressed?: boolean;
  providerStatus: ServerProvider | null;
}) {
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

  if (suppressed || !shouldShowSessionStartupNotice({ isSessionStarting, nowMs, startedAt })) {
    return null;
  }

  return (
    <CompactStatusNoticeRow
      title="Session startup"
      message={SESSION_STARTUP_SLOW_MESSAGE}
      errorText={refreshError}
      actions={
        <StatusNoticeActionButtons
          variant="ghost"
          isRefreshing={isRefreshing}
          onRefresh={providerStatus ? refreshProvider : null}
        />
      }
    />
  );
});
