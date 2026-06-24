import { ProviderDriverKind, type ServerProvider } from "@threadlines/contracts";
import { Link } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { ActivityIcon, CircleAlertIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");
export const PROVIDER_STATUS_SLOW_NOTICE_DELAY_MS = 25_000;

type ProviderStatusNoticeKind = "hidden" | "compact" | "alert";

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

function getPendingProbeNoticeDelayMs(status: ServerProvider, nowMs: number): number {
  if (
    status.status !== "warning" ||
    status.statusReason !== "provider_probe_pending" ||
    !isCodexProviderProbeStatus(status)
  ) {
    return 0;
  }
  return Math.max(0, PROVIDER_STATUS_SLOW_NOTICE_DELAY_MS - providerStatusAgeMs(status, nowMs));
}

export function getProviderStatusNoticeKind(
  status: ServerProvider | null,
  options?: {
    readonly activeTurnInProgress?: boolean;
    readonly nowMs?: number;
  },
): ProviderStatusNoticeKind {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return "hidden";
  }
  if (status.status === "error") {
    return "alert";
  }
  if (options?.activeTurnInProgress === true && status.status === "warning") {
    return "hidden";
  }
  if (isCodexProviderProbeStatus(status)) {
    if (
      status.statusReason === "provider_probe_pending" &&
      getPendingProbeNoticeDelayMs(status, options?.nowMs ?? Date.now()) > 0
    ) {
      return "hidden";
    }
    return "compact";
  }
  return "alert";
}

export function shouldRenderProviderStatusBanner(
  status: ServerProvider | null,
  options?: {
    readonly activeTurnInProgress?: boolean;
    readonly nowMs?: number;
  },
): boolean {
  return getProviderStatusNoticeKind(status, options) !== "hidden";
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  activeTurnInProgress = false,
  status,
}: {
  activeTurnInProgress?: boolean;
  status: ServerProvider | null;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshProvider = useCallback(() => {
    if (!status || isRefreshing) {
      return;
    }

    setRefreshError(null);
    setIsRefreshing(true);
    void ensureLocalApi()
      .server.refreshProviders({ instanceId: status.instanceId })
      .catch((error: unknown) => {
        setRefreshError(
          error instanceof Error ? error.message : "Provider status could not be refreshed.",
        );
      })
      .finally(() => {
        setIsRefreshing(false);
      });
  }, [isRefreshing, status]);

  useEffect(() => {
    setNowMs(Date.now());
  }, [status?.checkedAt, status?.instanceId, status?.statusReason]);

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

  if (!status) {
    return null;
  }

  const noticeKind = getProviderStatusNoticeKind(status, {
    activeTurnInProgress,
    nowMs,
  });
  if (noticeKind === "hidden") {
    return null;
  }

  const providerLabel = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = `${providerLabel} provider status`;
  const message =
    status.statusReason === "provider_probe_pending"
      ? `${providerLabel} status check is taking longer than usual. Existing sessions may still work.`
      : (status.message ?? defaultMessage);

  if (noticeKind === "compact") {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 pt-2 sm:px-0">
        <div
          className="mx-auto flex max-w-2xl flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-warning/20 bg-warning/5 px-2.5 py-1.5 text-xs shadow-sm shadow-warning/5"
          role="status"
        >
          <CircleAlertIcon className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
          <div className="min-w-56 flex-1 leading-5">
            <span className="font-medium text-foreground">{title}: </span>
            <span className="text-muted-foreground">{message}</span>
            {refreshError ? (
              <span className="block text-[11px] text-warning-foreground/85">{refreshError}</span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="xs"
              variant="ghost"
              className="h-6 px-1.5"
              onClick={refreshProvider}
              disabled={isRefreshing}
              aria-label="Refresh provider status"
            >
              {isRefreshing ? (
                <LoaderIcon className="size-3 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3" />
              )}
              <span>{isRefreshing ? "Refreshing" : "Refresh"}</span>
            </Button>
            <Button
              size="xs"
              variant="ghost"
              className="h-6 px-1.5"
              render={<Link to="/settings/diagnostics" />}
              aria-label="Open diagnostics"
            >
              <ActivityIcon className="size-3" />
              <span>Diagnostics</span>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription title={message}>
          <span className="line-clamp-3">{message}</span>
          {refreshError ? <span className="text-[11px]">{refreshError}</span> : null}
        </AlertDescription>
        <AlertAction>
          <Button
            size="xs"
            variant="outline"
            onClick={refreshProvider}
            disabled={isRefreshing}
            aria-label="Refresh provider status"
          >
            {isRefreshing ? (
              <LoaderIcon className="size-3 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3" />
            )}
            <span>{isRefreshing ? "Refreshing" : "Refresh"}</span>
          </Button>
          <Button
            size="xs"
            variant="outline"
            render={<Link to="/settings/diagnostics" />}
            aria-label="Open diagnostics"
          >
            <ActivityIcon className="size-3" />
            <span>Diagnostics</span>
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
});
