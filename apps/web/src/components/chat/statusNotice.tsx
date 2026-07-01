import type { ProviderInstanceId } from "@threadlines/contracts";
import { Link } from "@tanstack/react-router";
import { useCallback, useState, type ReactNode } from "react";
import { ActivityIcon, CircleAlertIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";

export function useProviderStatusRefresh(instanceId: ProviderInstanceId | null): {
  isRefreshing: boolean;
  refreshError: string | null;
  refreshProvider: () => void;
} {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshProvider = useCallback(() => {
    if (instanceId === null || isRefreshing) {
      return;
    }

    setRefreshError(null);
    setIsRefreshing(true);
    void ensureLocalApi()
      .server.refreshProviders({ instanceId })
      .catch((error: unknown) => {
        setRefreshError(
          error instanceof Error ? error.message : "Provider status could not be refreshed.",
        );
      })
      .finally(() => {
        setIsRefreshing(false);
      });
  }, [instanceId, isRefreshing]);
  return { isRefreshing, refreshError, refreshProvider };
}

export function StatusNoticeActionButtons({
  variant,
  isRefreshing,
  onRefresh,
}: {
  variant: "ghost" | "outline";
  isRefreshing: boolean;
  onRefresh: (() => void) | null;
}) {
  const buttonClassName = variant === "ghost" ? "h-6 px-1.5" : undefined;
  return (
    <>
      {onRefresh ? (
        <Button
          size="xs"
          variant={variant}
          className={buttonClassName}
          onClick={onRefresh}
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
      ) : null}
      <Button
        size="xs"
        variant={variant}
        className={buttonClassName}
        render={<Link to="/settings/diagnostics" />}
        aria-label="Open diagnostics"
      >
        <ActivityIcon className="size-3" />
        <span>Diagnostics</span>
      </Button>
    </>
  );
}

export function CompactStatusNoticeRow({
  title,
  message,
  errorText,
  actions,
}: {
  title: string;
  message: string;
  errorText?: string | null;
  actions: ReactNode;
}) {
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
          {errorText ? (
            <span className="block text-[11px] text-warning-foreground/85">{errorText}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      </div>
    </div>
  );
}
