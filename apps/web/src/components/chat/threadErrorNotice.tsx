/**
 * The composer notice for a turn that already failed.
 *
 * @module threadErrorNotice
 */
import { isProviderPlanGateMessage } from "@threadlines/shared/providerPlan";
import { ExternalLinkIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";

import { ensureLocalApi } from "../../localApi";
import type { ProviderAuthReconnectAction } from "../../session-logic";
import { formatProviderRateLimitResetCreditTooltip } from "../ProviderRateLimitResetCredit";
import { Button } from "../ui/button";
import type { ComposerNotice } from "./composerNotices";
import { buildProviderSignInNotice } from "./providerReadinessNotice";
import type { ProviderSignInFlowView } from "./providerSignIn";

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
  planUpgradeUrl,
  signIn,
  onDismiss,
}: {
  error: string | null;
  authReconnect?: ProviderAuthReconnectAction | null;
  usageReset?: UsageResetAction | null;
  retry?: TurnRetryAction | null;
  providerLabel?: string;
  /** The active provider's subscription page, for plan-gate failures. */
  planUpgradeUrl?: string | null;
  /** Live state of the active instance's sign-in flow. */
  signIn?: ProviderSignInFlowView | undefined;
  onDismiss?: () => void;
}): ComposerNotice | null {
  if (!error) {
    return null;
  }

  // The provider refused the selected model for this account's plan; a retry
  // is guaranteed to fail, so the one useful action is the upgrade page.
  if (planUpgradeUrl && isProviderPlanGateMessage(error)) {
    return {
      id: "thread-error-plan",
      severity: "warning",
      lead: `${providerLabel?.trim() || "This provider"} plan limit.`,
      detail: `${error} Pick another model, or upgrade your ${providerLabel?.trim() || "provider"} plan.`,
      actions: (
        <Button
          size="xs"
          aria-label={`Open the ${providerLabel?.trim() || "provider"} upgrade page`}
          onClick={() => {
            void ensureLocalApi()
              .shell.openExternal(planUpgradeUrl)
              .catch(() => {});
          }}
        >
          <ExternalLinkIcon className="size-3" />
          Upgrade plan
        </Button>
      ),
      dismissLabel: "Dismiss",
      ...(onDismiss ? { onDismiss } : {}),
    };
  }

  if (authReconnect) {
    return buildProviderSignInNotice({
      id: "thread-error-auth",
      providerLabel: providerLabel?.trim() || "Provider",
      detailSuffix: `Last error: ${error}`,
      signIn,
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
