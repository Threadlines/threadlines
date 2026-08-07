import { memo } from "react";
import type { ProviderAuthReconnectAction } from "../../session-logic";
import { formatProviderRateLimitResetCreditTooltip } from "../ProviderRateLimitResetCredit";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RefreshCwIcon, RotateCcwIcon } from "lucide-react";
import { DismissNoticeButton, ProviderSignInNotice } from "./ProviderReadinessNotice";
import { CompactStatusNoticeRow } from "./statusNotice";

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
    return (
      <ProviderSignInNotice
        providerLabel={providerLabel?.trim() || "Provider"}
        command={authReconnect.command}
        errorText={<>Last error: {error}</>}
        onRunSignIn={onRunAuthReconnect ? () => onRunAuthReconnect(authReconnect) : undefined}
        {...(onDismiss ? { onDismiss } : {})}
      />
    );
  }

  return (
    <CompactStatusNoticeRow
      tone="error"
      title="Thread error"
      message={error}
      actions={
        <>
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
          {onDismiss ? <DismissNoticeButton onDismiss={onDismiss} /> : null}
        </>
      }
    />
  );
});
