/**
 * The composer notice for a turn that already failed.
 *
 * @module threadErrorNotice
 */
import { RefreshCwIcon, RotateCcwIcon } from "lucide-react";

import type { ProviderAuthReconnectAction } from "../../session-logic";
import { formatProviderRateLimitResetCreditTooltip } from "../ProviderRateLimitResetCredit";
import { Button } from "../ui/button";
import type { ComposerNotice } from "./composerNotices";
import { buildProviderSignInNotice } from "./providerReadinessNotice";

interface UsageResetAction {
  readonly availableCount: number;
  readonly isResetting?: boolean;
  readonly onReset: () => void;
}

interface TurnRetryAction {
  readonly isRetrying: boolean;
  readonly onRetry: () => void;
}

export function buildThreadErrorNotice({
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
}): ComposerNotice | null {
  if (!error) {
    return null;
  }

  if (authReconnect) {
    return buildProviderSignInNotice({
      id: "thread-error-auth",
      providerLabel: providerLabel?.trim() || "Provider",
      command: authReconnect.command,
      detailSuffix: `Last error: ${error}`,
      onRunSignIn: onRunAuthReconnect ? () => onRunAuthReconnect(authReconnect) : undefined,
      ...(onDismiss ? { onDismiss } : {}),
    });
  }

  return {
    id: "thread-error",
    severity: "error",
    lead: "Turn failed.",
    detail: error,
    actions: (
      <>
        {retry ? (
          <Button
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
          <Button
            size="xs"
            disabled={usageReset.isResetting === true}
            onClick={usageReset.onReset}
            aria-label="Reset Codex usage"
            tooltip={formatProviderRateLimitResetCreditTooltip(usageReset.availableCount)}
            tooltipSide="top"
          >
            <RotateCcwIcon className="size-3" />
            {usageReset.isResetting ? "Resetting" : "Reset usage"}
          </Button>
        ) : null}
      </>
    ),
    dismissLabel: "Dismiss error",
    ...(onDismiss ? { onDismiss } : {}),
  };
}
