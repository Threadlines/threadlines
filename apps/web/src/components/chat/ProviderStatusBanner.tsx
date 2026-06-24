import { type ServerProvider } from "@threadlines/contracts";
import { Link } from "@tanstack/react-router";
import { memo, useCallback, useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { ActivityIcon, CircleAlertIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";

export function shouldRenderProviderStatusBanner(
  status: ServerProvider | null,
  options?: {
    readonly activeTurnInProgress?: boolean;
  },
): boolean {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return false;
  }
  return !(options?.activeTurnInProgress === true && status.status === "warning");
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  activeTurnInProgress = false,
  status,
}: {
  activeTurnInProgress?: boolean;
  status: ServerProvider | null;
}) {
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

  if (!shouldRenderProviderStatusBanner(status, { activeTurnInProgress })) {
    return null;
  }
  if (!status) {
    return null;
  }

  const providerLabel = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = `${providerLabel} provider status`;

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription title={status.message ?? defaultMessage}>
          <span className="line-clamp-3">{status.message ?? defaultMessage}</span>
          {refreshError ? (
            <span className="text-[11px]" role="status">
              {refreshError}
            </span>
          ) : null}
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
