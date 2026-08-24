/**
 * The composer notice for an unhealthy provider snapshot.
 *
 * One row, but not one action: "Refresh and Diagnostics" is the right answer
 * for a probe that timed out and the wrong answer for a provider that is
 * simply signed out, where the only useful button is the one that signs in.
 * `resolveProviderStatusNoticeActions` reads the structured snapshot fields
 * (never the message text, which is provider prose) and says which actions the
 * row earns.
 *
 * @module providerStatusNotice
 */
import type { ServerProvider } from "@threadlines/contracts";
import { Link } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { LinkifiedText } from "../../lib/linkifiedText";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { Button } from "../ui/button";
import type { ComposerNotice } from "./composerNotices";
import {
  isProviderSignInInFlight,
  providerSignInStatusText,
  ProviderSignInButton,
  type ProviderSignInFlowView,
} from "./providerSignIn";
import { StatusNoticeActionButtons, useProviderStatusRefresh } from "./statusNotice";

export const PROVIDER_STATUS_SLOW_NOTICE_DELAY_MS = 45_000;
export const PROVIDER_STATUS_TIMEOUT_NOTICE_DELAY_MS = 120_000;

function isRecoverableProviderProbeStatus(status: ServerProvider): boolean {
  return (
    status.statusReason === "provider_probe_pending" ||
    status.statusReason === "provider_probe_timeout"
  );
}

function providerStatusAgeMs(status: ServerProvider, nowMs: number): number {
  const checkedAtMs = Date.parse(status.checkedAt);
  if (!Number.isFinite(checkedAtMs)) {
    return PROVIDER_STATUS_TIMEOUT_NOTICE_DELAY_MS;
  }
  return Math.max(0, nowMs - checkedAtMs);
}

export function getPendingProbeNoticeDelayMs(status: ServerProvider, nowMs: number): number {
  if (status.status !== "warning" || status.statusReason !== "provider_probe_pending") {
    return 0;
  }
  return Math.max(0, PROVIDER_STATUS_SLOW_NOTICE_DELAY_MS - providerStatusAgeMs(status, nowMs));
}

export function getTimedOutProbeNoticeDelayMs(status: ServerProvider, nowMs: number): number {
  if (status.statusReason !== "provider_probe_timeout") {
    return 0;
  }
  return Math.max(0, PROVIDER_STATUS_TIMEOUT_NOTICE_DELAY_MS - providerStatusAgeMs(status, nowMs));
}

export function shouldShowProviderStatusNotice(
  status: ServerProvider | null,
  options?: {
    readonly activeTurnInProgress?: boolean;
    readonly nowMs?: number;
  },
): boolean {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return false;
  }
  if (status.status === "error") {
    if (isRecoverableProviderProbeStatus(status)) {
      if (options?.activeTurnInProgress === true) {
        return false;
      }
      if (getTimedOutProbeNoticeDelayMs(status, options?.nowMs ?? Date.now()) > 0) {
        return false;
      }
    }
    return true;
  }
  if (options?.activeTurnInProgress === true) {
    return false;
  }
  if (
    status.statusReason === "provider_probe_pending" &&
    getPendingProbeNoticeDelayMs(status, options?.nowMs ?? Date.now()) > 0
  ) {
    return false;
  }
  if (getTimedOutProbeNoticeDelayMs(status, options?.nowMs ?? Date.now()) > 0) {
    return false;
  }
  return true;
}

/**
 * Which actions a snapshot earns. Every field is decided from structured
 * state, so a provider that reworded its error message cannot change the
 * buttons the user is offered.
 */
export interface ProviderStatusNoticeActions {
  /** Start the hidden sign-in flow. Never shares the row with the rest. */
  readonly signIn: boolean;
  /** Route to the providers page, for something no button here can fix. */
  readonly openSettings: boolean;
  readonly refresh: boolean;
  readonly diagnostics: boolean;
}

export function resolveProviderStatusNoticeActions(
  status: ServerProvider,
): ProviderStatusNoticeActions {
  // Turned off on purpose: the only thing to do about it is turn it back on,
  // and re-probing a disabled provider tells nobody anything.
  if (!status.enabled) {
    return { signIn: false, openSettings: true, refresh: false, diagnostics: false };
  }
  // No CLI on PATH. There is nothing to sign in to, but a refresh is worth
  // offering because an install that just finished is invisible until we look.
  if (!status.installed) {
    return { signIn: false, openSettings: true, refresh: true, diagnostics: false };
  }
  // Installed and definitely signed out. Refreshing and reading diagnostics
  // both just confirm what the snapshot already says.
  if (
    status.auth.capabilities?.chat?.status === "unavailable" ||
    status.auth.status === "unauthenticated"
  ) {
    return { signIn: true, openSettings: false, refresh: false, diagnostics: false };
  }
  // Everything else is a probe that has not answered, timed out, or came back
  // unhappy in a way we cannot name: look again, or go read the logs.
  return { signIn: false, openSettings: false, refresh: true, diagnostics: true };
}

/**
 * Builds the provider-status notice, including delayed reveals for recoverable
 * probes. A slow or timed-out health check is usually about to heal in the
 * background, so it only earns the row after a sustained failure.
 */
export function useProviderStatusNotice(input: {
  readonly status: ServerProvider | null;
  readonly activeTurnInProgress: boolean;
  /**
   * Live state of this instance's sign-in flow, supplied by the surface that
   * owns it. Without it, a signed-out provider still gets the sign-in row but
   * cannot report progress.
   */
  readonly signIn?: ProviderSignInFlowView | undefined;
  /**
   * True while a held-send notice is up for this same instance. That notice
   * states the identical fact with the actions that resolve it, and severity
   * ranking would otherwise put this vaguer row in front of it.
   */
  readonly suppressed?: boolean;
}): ComposerNotice | null {
  const { activeTurnInProgress, signIn, status, suppressed = false } = input;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { isRefreshing, refreshError, refreshProvider } = useProviderStatusRefresh(
    status?.instanceId ?? null,
  );

  const checkedAt = status?.checkedAt;
  const instanceId = status?.instanceId;
  const statusReason = status?.statusReason;
  useEffect(() => {
    setNowMs(Date.now());
  }, [activeTurnInProgress, checkedAt, instanceId, statusReason]);

  useEffect(() => {
    if (!status || activeTurnInProgress) {
      return;
    }
    const remainingMs = Math.max(
      getPendingProbeNoticeDelayMs(status, nowMs),
      getTimedOutProbeNoticeDelayMs(status, nowMs),
    );
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

  const visible =
    !suppressed && shouldShowProviderStatusNotice(status, { activeTurnInProgress, nowMs });

  return useMemo(() => {
    if (!status || !visible) {
      return null;
    }
    const providerLabel =
      status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
    const actions = resolveProviderStatusNoticeActions(status);
    const signInRunning =
      actions.signIn && signIn !== undefined && isProviderSignInInFlight(signIn);
    const defaultMessage =
      status.status === "error"
        ? `${providerLabel} provider is unavailable.`
        : `${providerLabel} provider has limited availability.`;
    const message =
      status.statusReason === "provider_probe_pending"
        ? `${providerLabel} status check is taking longer than usual. Existing sessions may still work.`
        : (status.message ?? defaultMessage);
    const flowStatus = actions.signIn && signIn ? providerSignInStatusText(signIn) : null;
    const detailText = refreshError ? `${message} ${refreshError}` : message;

    return {
      id: `provider-status:${status.instanceId}`,
      severity: status.status === "error" ? "error" : "warning",
      lead: signInRunning ? `Signing in to ${providerLabel}.` : `${providerLabel} provider status`,
      detail: flowStatus ?? <LinkifiedText text={detailText} />,
      actions: (
        <>
          {actions.signIn && signIn ? <ProviderSignInButton view={signIn} /> : null}
          {actions.openSettings ? (
            <Button
              size="xs"
              variant="ghost"
              className="h-6 px-1.5"
              render={<Link to="/settings/providers" />}
            >
              <SettingsIcon className="size-3" />
              Open Settings
            </Button>
          ) : null}
          {actions.refresh || actions.diagnostics ? (
            <StatusNoticeActionButtons
              variant="ghost"
              isRefreshing={isRefreshing}
              onRefresh={actions.refresh ? refreshProvider : null}
              showDiagnostics={actions.diagnostics}
            />
          ) : null}
        </>
      ),
    } satisfies ComposerNotice;
  }, [isRefreshing, refreshError, refreshProvider, signIn, status, visible]);
}
