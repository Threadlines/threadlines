import type { EnvironmentId, ProviderInstanceId } from "@threadlines/contracts";
import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { ActivityIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { refreshProviderStatus } from "../../environments/providerStatusRefresh";
import { Button } from "../ui/button";

/**
 * Refresh for a provider's status, asked of the computer the thread runs on
 * (`environmentId`; null asks the app's own backend).
 */
export function useProviderStatusRefresh(input: {
  readonly environmentId: EnvironmentId | null;
  readonly instanceId: ProviderInstanceId | null;
}): {
  isRefreshing: boolean;
  refreshError: string | null;
  refreshProvider: () => void;
} {
  const { environmentId, instanceId } = input;
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshProvider = useCallback(() => {
    if (instanceId === null || isRefreshing) {
      return;
    }

    setRefreshError(null);
    setIsRefreshing(true);
    void refreshProviderStatus({ environmentId, instanceId })
      .catch((error: unknown) => {
        setRefreshError(
          error instanceof Error ? error.message : "Provider status could not be refreshed.",
        );
      })
      .finally(() => {
        setIsRefreshing(false);
      });
  }, [environmentId, instanceId, isRefreshing]);
  return { isRefreshing, refreshError, refreshProvider };
}

export function StatusNoticeActionButtons({
  variant = "ghost",
  isRefreshing,
  onRefresh,
  showDiagnostics = true,
}: {
  variant?: "ghost" | "outline";
  isRefreshing: boolean;
  onRefresh: (() => void) | null;
  /**
   * Diagnostics is the answer to "the server tried and something went wrong".
   * Rows for a condition the logs cannot explain (a signed-out CLI, a missing
   * install) turn it off rather than sending the user to read nothing.
   */
  showDiagnostics?: boolean;
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
      {showDiagnostics ? (
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
      ) : null}
    </>
  );
}
