/**
 * The composer notice for an unhealthy provider snapshot.
 *
 * @module providerStatusNotice
 */
import { ProviderDriverKind, type ServerProvider } from "@threadlines/contracts";
import { useEffect, useMemo, useState } from "react";

import { formatProviderDriverKindLabel } from "../../providerModels";
import type { ComposerNotice } from "./composerNotices";
import { StatusNoticeActionButtons, useProviderStatusRefresh } from "./statusNotice";

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");
export const PROVIDER_STATUS_SLOW_NOTICE_DELAY_MS = 25_000;

function isCodexProviderProbeStatus(status: ServerProvider): boolean {
  return (
    status.driver === CODEX_DRIVER_KIND &&
    (status.statusReason === "provider_probe_pending" ||
      status.statusReason === "provider_probe_timeout")
  );
}

function providerStatusAgeMs(status: ServerProvider, nowMs: number): number {
  const checkedAtMs = Date.parse(status.checkedAt);
  if (!Number.isFinite(checkedAtMs)) {
    return PROVIDER_STATUS_SLOW_NOTICE_DELAY_MS;
  }
  return Math.max(0, nowMs - checkedAtMs);
}

export function getPendingProbeNoticeDelayMs(status: ServerProvider, nowMs: number): number {
  if (
    status.status !== "warning" ||
    status.statusReason !== "provider_probe_pending" ||
    !isCodexProviderProbeStatus(status)
  ) {
    return 0;
  }
  return Math.max(0, PROVIDER_STATUS_SLOW_NOTICE_DELAY_MS - providerStatusAgeMs(status, nowMs));
}

export function shouldShowProviderStatusNotice(
  status: ServerProvider | null,
  options?: {
    readonly activeTurnInProgress?: boolean;
    readonly nowMs?: number;
  },
): boolean {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return false;
  }
  if (status.status === "error") {
    return true;
  }
  if (options?.activeTurnInProgress === true) {
    return false;
  }
  if (
    isCodexProviderProbeStatus(status) &&
    status.statusReason === "provider_probe_pending" &&
    getPendingProbeNoticeDelayMs(status, options?.nowMs ?? Date.now()) > 0
  ) {
    return false;
  }
  return true;
}

/**
 * Builds the provider-status notice, including the delayed reveal for a Codex
 * probe that is merely slow: a probe that has not answered yet is usually
 * about to, so it only earns the row once it has been pending long enough to
 * be worth mentioning.
 */
export function useProviderStatusNotice(input: {
  readonly status: ServerProvider | null;
  readonly activeTurnInProgress: boolean;
  /**
   * True while a held-send notice is up for this same instance. That notice
   * states the identical fact with the actions that resolve it, and severity
   * ranking would otherwise put this vaguer row in front of it.
   */
  readonly suppressed?: boolean;
}): ComposerNotice | null {
  const { activeTurnInProgress, status, suppressed = false } = input;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { isRefreshing, refreshError, refreshProvider } = useProviderStatusRefresh(
    status?.instanceId ?? null,
  );

  const checkedAt = status?.checkedAt;
  const instanceId = status?.instanceId;
  const statusReason = status?.statusReason;
  useEffect(() => {
    setNowMs(Date.now());
  }, [checkedAt, instanceId, statusReason]);

  useEffect(() => {
    if (!status || activeTurnInProgress) {
      return;
    }
    const remainingMs = getPendingProbeNoticeDelayMs(status, nowMs);
    if (remainingMs <= 0) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setNowMs(Date.now());
    }, remainingMs + 50);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeTurnInProgress, nowMs, status]);

  const visible =
    !suppressed && shouldShowProviderStatusNotice(status, { activeTurnInProgress, nowMs });

  return useMemo(() => {
    if (!status || !visible) {
      return null;
    }
    const providerLabel =
      status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
    const defaultMessage =
      status.status === "error"
        ? `${providerLabel} provider is unavailable.`
        : `${providerLabel} provider has limited availability.`;
    const message =
      status.statusReason === "provider_probe_pending"
        ? `${providerLabel} status check is taking longer than usual. Existing sessions may still work.`
        : (status.message ?? defaultMessage);

    return {
      id: `provider-status:${status.instanceId}`,
      severity: status.status === "error" ? "error" : "warning",
      lead: `${providerLabel} provider status`,
      detail: refreshError ? `${message} ${refreshError}` : message,
      actions: (
        <StatusNoticeActionButtons
          variant="ghost"
          isRefreshing={isRefreshing}
          onRefresh={refreshProvider}
        />
      ),
    } satisfies ComposerNotice;
  }, [isRefreshing, refreshError, refreshProvider, status, visible]);
}
