import { memo } from "react";
import type { ProviderAuthReconnectAction } from "../../session-logic";
import { formatProviderRateLimitResetCreditTooltip } from "../ProviderRateLimitResetCredit";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CircleAlertIcon, RefreshCwIcon, RotateCcwIcon, TerminalIcon, XIcon } from "lucide-react";

type UsageResetAction = {
  availableCount: number;
  isResetting?: boolean;
  onReset: () => void;
};

type TurnRetryAction = {
  isRetrying: boolean;
  onRetry: () => void;
};

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  authReconnect,
  usageReset,
  retry,
  providerLabel,
  onRunAuthReconnect,
  onDismiss,
}: {
  error: string | null;
  authReconnect?: ProviderAuthReconnectAction | null;
  usageReset?: UsageResetAction | null;
  retry?: TurnRetryAction | null;
  providerLabel?: string;
  onRunAuthReconnect?: (action: ProviderAuthReconnectAction) => void;
  onDismiss?: () => void;
}) {
  if (!error) return null;

  if (authReconnect) {
    const label = providerLabel?.trim() || "Provider";
    return (
      <div className="pt-3 mx-auto max-w-3xl">
        <Alert variant="error">
          <CircleAlertIcon />
          <AlertTitle>{label} sign-in required</AlertTitle>
          <AlertDescription>
            <p>
              Run <code className="font-mono text-foreground/85">{authReconnect.command}</code>,
              complete the browser sign-in, then retry this message.
            </p>
            <p className="line-clamp-2 text-[11px] text-muted-foreground/60" title={error}>
              Last error: {error}
            </p>
          </AlertDescription>
          <AlertAction>
            <Button
              size="xs"
              disabled={!onRunAuthReconnect}
              onClick={() => onRunAuthReconnect?.(authReconnect)}
            >
              <TerminalIcon className="size-3" />
              Sign in in terminal
            </Button>
            {onDismiss && (
              <button
                type="button"
                aria-label="Dismiss error"
                className="inline-flex size-6 items-center justify-center rounded-md text-destructive/60 transition-colors hover:text-destructive"
                onClick={onDismiss}
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </AlertAction>
        </Alert>
      </div>
    );
  }

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertDescription className="line-clamp-3" title={error}>
          {error}
        </AlertDescription>
        {(retry || usageReset || onDismiss) && (
          <AlertAction>
            {retry ? (
              <Button
                type="button"
                size="xs"
                disabled={retry.isRetrying}
                onClick={retry.onRetry}
                aria-label="Retry last message"
              >
                <RefreshCwIcon className={retry.isRetrying ? "size-3 animate-spin" : "size-3"} />
                {retry.isRetrying ? "Retrying" : "Retry"}
              </Button>
            ) : null}
            {usageReset ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex">
                      <Button
                        type="button"
                        size="xs"
                        disabled={usageReset.isResetting === true}
                        onClick={usageReset.onReset}
                        aria-label="Reset Codex usage"
                      >
                        <RotateCcwIcon className="size-3" />
                        {usageReset.isResetting ? "Resetting" : "Reset usage"}
                      </Button>
                    </span>
                  }
                />
                <TooltipPopup side="top" align="end" className="max-w-64">
                  {formatProviderRateLimitResetCreditTooltip(usageReset.availableCount)}
                </TooltipPopup>
              </Tooltip>
            ) : null}
            {onDismiss ? (
              <button
                type="button"
                aria-label="Dismiss error"
                className="inline-flex size-6 items-center justify-center rounded-md text-destructive/60 transition-colors hover:text-destructive"
                onClick={onDismiss}
              >
                <XIcon className="size-3.5" />
              </button>
            ) : null}
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
