import { ProviderDriverKind, type ServerProvider } from "@threadlines/contracts";
import { memo, useEffect, useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { CircleAlertIcon } from "lucide-react";
import { formatProviderDriverKindLabel } from "../../providerModels";
import {
  CompactStatusNoticeRow,
  StatusNoticeActionButtons,
  useProviderStatusRefresh,
} from "./statusNotice";

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
  const { isRefreshing, refreshError, refreshProvider } = useProviderStatusRefresh(
    status?.instanceId ?? null,
  );

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
      <CompactStatusNoticeRow
        title={title}
        message={message}
        errorText={refreshError}
        actions={
          <StatusNoticeActionButtons
            variant="ghost"
            isRefreshing={isRefreshing}
            onRefresh={refreshProvider}
          />
        }
      />
    );
  }

  return (
    <div className="pt-3 mx-auto max-w-4xl">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription title={message}>
          <span className="line-clamp-3">{message}</span>
          {refreshError ? <span className="text-[11px]">{refreshError}</span> : null}
        </AlertDescription>
        <AlertAction>
          <StatusNoticeActionButtons
            variant="outline"
            isRefreshing={isRefreshing}
            onRefresh={refreshProvider}
          />
        </AlertAction>
      </Alert>
    </div>
  );
});
