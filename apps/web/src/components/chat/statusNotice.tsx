import type { ProviderInstanceId } from "@threadlines/contracts";
import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { ActivityIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
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
  variant = "ghost",
  isRefreshing,
  onRefresh,
}: {
  variant?: "ghost" | "outline";
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
