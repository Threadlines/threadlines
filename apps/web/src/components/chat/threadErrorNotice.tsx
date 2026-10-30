/**
 * The composer notice for a turn that already failed.
 *
 * @module threadErrorNotice
 */
import type { OrchestrationUsageLimitWindow } from "@threadlines/contracts";
import { isProviderPlanGateMessage } from "@threadlines/shared/providerPlan";
import { ChevronDownIcon, ExternalLinkIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useRelativeTimeTick } from "~/hooks/useRelativeTimeTick";
import { openExternalUrl } from "../../lib/externalLinks";
import type { ProviderAuthReconnectPrompt } from "../ChatView.logic";
import { formatProviderRateLimitResetCreditTooltip } from "../ProviderRateLimitResetCredit";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { formatCheckBackTime } from "./checkBacks";
import type { ComposerNotice } from "./composerNotices";
import { buildProviderSignInNotice } from "./providerReadinessNotice";
import type { ProviderSignInFlowView } from "./providerSignIn";

interface UsageResetAction {
  readonly availableCount: number;
  readonly isResetting?: boolean;
  readonly onReset: () => void;
}

/** A provider-owned page where the user can spend a limit reset themselves. */
interface UsageResetLink {
  readonly label: string;
  readonly url: string;
}

interface TurnRetryAction {
  readonly isRetrying: boolean;
  readonly onRetry: () => void;
}

/** The failure is the user's plan usage limit (OrchestrationSession.lastErrorUsageLimit). */
export interface UsageLimitNoticeState {
  readonly window: OrchestrationUsageLimitWindow;
  /** When it resets, when the agent said. */
  readonly resetsAt: string | null;
  /** When the thread continues by itself; null while "Continue at reset" is off. */
  readonly continueAt: string | null;
  /** Whether the switch is offered: the reset time is known. */
  readonly canContinue: boolean;
  readonly isSaving: boolean;
  readonly onContinueChange: (enabled: boolean) => void;
}

/** The user's other accounts of the same agent that still have room. */
export interface UsageLimitAccountSwitch {
  readonly accounts: ReadonlyArray<{ readonly instanceId: string; readonly label: string }>;
  readonly isSwitching: boolean;
  readonly onSwitch: (instanceId: string) => void;
}

const USAGE_LIMIT_WINDOW_LABELS: Record<OrchestrationUsageLimitWindow, string> = {
  session: "session limit",
  weekly: "weekly limit",
  other: "usage limit",
};

/** "at 2:20 PM" today, "Thu at 11:00 PM" later in the week. */
export function formatResetMoment(iso: string, nowMs: number): string {
  const when = formatCheckBackTime(iso, nowMs);
  return when.includes(" at ") ? when : `at ${when}`;
}

/** A reset time that stays right as the day turns, ticking only while it shows. */
function ResetMoment({ iso }: { iso: string }) {
  const nowMs = useRelativeTimeTick(60_000);
  return <>{formatResetMoment(iso, nowMs)}</>;
}

export function buildThreadErrorNotice({
  error,
  authReconnect,
  usageReset,
  usageResetLink,
  retry,
  providerLabel,
  agentLabel,
  usageLimit,
  accountSwitch,
  planUpgradeUrl,
  signIn,
  onDismiss,
}: {
  error: string | null;
  /** Set when signing in again would fix the failure; the notice offers the composer's Sign in. */
  authReconnect?: ProviderAuthReconnectPrompt | null;
  usageReset?: UsageResetAction | null;
  usageResetLink?: UsageResetLink | null;
  retry?: TurnRetryAction | null;
  providerLabel?: string;
  /** The agent's own name ("Claude"), whichever of its accounts the thread uses. */
  agentLabel?: string;
  usageLimit?: UsageLimitNoticeState | null;
  accountSwitch?: UsageLimitAccountSwitch | null;
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
          onClick={() => openExternalUrl(planUpgradeUrl)}
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
      instruction: "Sign in, then retry your message.",
      detailSuffix: `Last error: ${error}`,
      signIn,
      ...(onDismiss ? { onDismiss } : {}),
    });
  }

  const usageResetAction = usageReset ? (
    <Button
      size="xs"
      disabled={usageReset.isResetting === true}
      onClick={usageReset.onReset}
      aria-label={`Reset ${providerLabel ?? "provider"} usage`}
      tooltip={formatProviderRateLimitResetCreditTooltip(
        usageReset.availableCount,
        providerLabel ?? "provider",
      )}
      tooltipSide="top"
    >
      <RotateCcwIcon className="size-3" />
      {usageReset.isResetting ? "Resetting" : "Reset usage"}
    </Button>
  ) : usageResetLink ? (
    <Button
      size="xs"
      variant="outline"
      onClick={() => openExternalUrl(usageResetLink.url)}
      tooltip="Limit resets are spent on claude.ai and refill Claude here too."
      tooltipSide="top"
    >
      <ExternalLinkIcon className="size-3" />
      {usageResetLink.label}
    </Button>
  ) : null;

  if (usageLimit) {
    return buildUsageLimitNotice({
      error,
      usageLimit,
      accountSwitch: accountSwitch ?? null,
      agentLabel: agentLabel?.trim() || providerLabel?.trim() || "This agent",
      usageResetAction,
      retry: retry ?? null,
      ...(onDismiss ? { onDismiss } : {}),
    });
  }

  const isOpenElsewhere = error.includes("already has an active writer");
  return {
    id: "thread-error",
    severity: isOpenElsewhere ? "warning" : "error",
    lead: isOpenElsewhere ? "Conversation open elsewhere." : "Turn failed.",
    detail: isOpenElsewhere
      ? "Close this conversation in the other Codex window, then retry. Your saved messages are still here."
      : error,
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
        {usageResetAction}
      </>
    ),
    dismissLabel: "Dismiss error",
    ...(onDismiss ? { onDismiss } : {}),
  };
}

/**
 * A turn the user's plan usage limit stopped. Nothing is broken, so it reads
 * as a warning: when the limit resets, the "Continue at reset" switch, and
 * the user's other accounts of the same agent that still have room. While the
 * thread waits to continue, the row says when and can't be closed: turning
 * the switch off is the way out.
 */
function buildUsageLimitNotice({
  error,
  usageLimit,
  accountSwitch,
  agentLabel,
  usageResetAction,
  retry,
  onDismiss,
}: {
  error: string;
  usageLimit: UsageLimitNoticeState;
  accountSwitch: UsageLimitAccountSwitch | null;
  agentLabel: string;
  usageResetAction: ReactNode;
  retry: TurnRetryAction | null;
  onDismiss?: () => void;
}): ComposerNotice {
  const limitLabel = USAGE_LIMIT_WINDOW_LABELS[usageLimit.window];
  const waiting = usageLimit.continueAt !== null;
  const showSwitch = usageLimit.canContinue || waiting;
  const accounts = accountSwitch?.accounts ?? [];
  const continueSwitch = showSwitch ? (
    <label className="inline-flex cursor-pointer items-center gap-1.5 pr-1 text-foreground">
      <Switch
        size="sm"
        checked={waiting}
        disabled={usageLimit.isSaving}
        onCheckedChange={(checked) => usageLimit.onContinueChange(Boolean(checked))}
        aria-label="Continue at reset"
      />
      Continue at reset
    </label>
  ) : null;
  const accountAction =
    accountSwitch === null || accounts.length === 0 ? null : accounts.length === 1 ? (
      <Button
        size="xs"
        disabled={accountSwitch.isSwitching}
        onClick={() => accountSwitch.onSwitch(accounts[0]!.instanceId)}
      >
        Use {accounts[0]!.label}
      </Button>
    ) : (
      <Menu>
        <MenuTrigger
          render={<Button size="xs" disabled={accountSwitch.isSwitching} />}
          aria-label="Use another account"
        >
          Use another account
          <ChevronDownIcon className="size-3" />
        </MenuTrigger>
        <MenuPopup align="end">
          {accounts.map((account) => (
            <MenuItem
              key={account.instanceId}
              onClick={() => accountSwitch.onSwitch(account.instanceId)}
            >
              {account.label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    );
  // With nothing else to do, Retry stays: a reset the user spent elsewhere
  // makes it worth trying now.
  const retryAction =
    retry && !continueSwitch && !accountAction ? (
      <Button
        size="xs"
        disabled={retry.isRetrying}
        onClick={retry.onRetry}
        aria-label="Retry last message"
      >
        <RefreshCwIcon className={retry.isRetrying ? "size-3 animate-spin" : "size-3"} />
        {retry.isRetrying ? "Retrying" : "Retry"}
      </Button>
    ) : null;
  const resetsAt = usageLimit.resetsAt;
  return {
    id: "thread-error-usage-limit",
    severity: waiting ? "info" : "warning",
    lead:
      usageLimit.continueAt !== null ? (
        <>
          Continues <ResetMoment iso={usageLimit.continueAt} />.
        </>
      ) : (
        `${agentLabel} ${limitLabel}.`
      ),
    detail:
      resetsAt === null ? (
        waiting ? undefined : (
          error
        )
      ) : waiting ? (
        <>
          {agentLabel}'s {limitLabel} resets <ResetMoment iso={resetsAt} />.
        </>
      ) : (
        <>
          Resets <ResetMoment iso={resetsAt} />.
        </>
      ),
    actions: (
      <>
        {continueSwitch}
        {accountAction}
        {usageResetAction}
        {retryAction}
      </>
    ),
    wrapActions: true,
    dismissLabel: "Dismiss",
    ...(!waiting && onDismiss ? { onDismiss } : {}),
  };
}
