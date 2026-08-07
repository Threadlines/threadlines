/**
 * The two ways an unusable provider reaches the composer notice dock.
 *
 * They arrive from two directions: after a turn already failed on a provider
 * auth error (the thread-error notice) and before a send we can tell in
 * advance will fail (ChatView's send preflight). Both directions have to read
 * the same, so the copy lives here once instead of being restated per surface.
 *
 * Signing in from either notice runs the server-side auth session (see
 * `providerSignIn`), not the thread's terminal, so the row also has to report
 * a run in progress: the flow's own line replaces the detail while it runs.
 *
 * @module providerReadinessNotice
 */
import { Link } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { ProviderSendPreflightPrompt } from "../ChatView.logic";
import { Button } from "../ui/button";
import type { ComposerNotice } from "./composerNotices";
import {
  isProviderSignInInFlight,
  providerSignInStatusText,
  ProviderSignInButton,
  type ProviderSignInFlowView,
} from "./providerSignIn";

export function buildProviderSignInNotice({
  id,
  severity = "error",
  providerLabel,
  instruction = "Complete the browser step and come back here.",
  detailSuffix,
  extraActions,
  signIn,
  onDismiss,
}: {
  id: string;
  severity?: ComposerNotice["severity"];
  providerLabel: string;
  /** What happens once the sign-in lands. */
  instruction?: string;
  detailSuffix?: string;
  extraActions?: ReactNode;
  /** Live state of this instance's sign-in flow, when the surface has one. */
  signIn?: ProviderSignInFlowView | undefined;
  onDismiss?: (() => void) | undefined;
}): ComposerNotice {
  const flowStatus = signIn ? providerSignInStatusText(signIn) : null;
  const inFlight = signIn !== undefined && isProviderSignInInFlight(signIn);
  const detail: ReactNode = flowStatus ?? (
    <>
      {instruction}
      {detailSuffix ? ` ${detailSuffix}` : null}
    </>
  );

  return {
    id,
    severity,
    lead: inFlight ? `Signing in to ${providerLabel}.` : `${providerLabel} needs sign-in.`,
    detail,
    actions: (
      <>
        {signIn ? <ProviderSignInButton view={signIn} /> : null}
        {extraActions}
      </>
    ),
    dismissLabel: `Dismiss ${providerLabel} sign-in notice`,
    ...(onDismiss ? { onDismiss } : {}),
  };
}

/**
 * Same shape for a provider whose CLI is missing. There is nothing to sign in
 * to yet, so the action routes to the place that lists install and sign-in
 * steps.
 */
export function buildProviderNotInstalledNotice({
  id,
  severity = "error",
  providerLabel,
  extraActions,
  onDismiss,
}: {
  id: string;
  severity?: ComposerNotice["severity"];
  providerLabel: string;
  extraActions?: ReactNode;
  onDismiss?: (() => void) | undefined;
}): ComposerNotice {
  return {
    id,
    severity,
    lead: `${providerLabel} isn't installed.`,
    detail: "Install it and sign in from Settings.",
    actions: (
      <>
        <Button size="xs" render={<Link to="/settings/providers" />}>
          <SettingsIcon className="size-3" />
          Open Settings
        </Button>
        {extraActions}
      </>
    ),
    dismissLabel: `Dismiss ${providerLabel} install notice`,
    ...(onDismiss ? { onDismiss } : {}),
  };
}

/**
 * Shown in place of a turn we held back. Nothing is ever hard-blocked: the
 * snapshot behind the verdict can be stale, so "I've signed in" re-checks the
 * provider and, when the fresh snapshot agrees, sends the held message down
 * the ordinary path. A sign-in started from this row runs that same recheck by
 * itself once the server reports success, so the held message releases without
 * a second click.
 */
export function buildProviderSendPreflightNotice({
  prompt,
  recheckFailed,
  isRechecking,
  signIn,
  onConfirmSignedIn,
  onDismiss,
}: {
  prompt: ProviderSendPreflightPrompt;
  recheckFailed: boolean;
  isRechecking: boolean;
  signIn: ProviderSignInFlowView;
  onConfirmSignedIn: () => void;
  onDismiss: () => void;
}): ComposerNotice {
  // A provider that isn't installed has nothing to sign in to yet, and one
  // without a known login command has no flow we can start, so both fall back
  // to the install-and-connect notice.
  if (prompt.reason === "notInstalled" || !prompt.command) {
    return buildProviderNotInstalledNotice({
      id: "provider-send-preflight",
      severity: "warning",
      providerLabel: prompt.providerLabel,
      onDismiss,
    });
  }

  const confirmSignedIn = (
    <Button
      size="xs"
      variant="ghost"
      className="h-6 px-1.5 text-muted-foreground hover:text-foreground"
      disabled={isRechecking}
      onClick={onConfirmSignedIn}
    >
      {isRechecking ? "Checking" : "I've signed in"}
    </Button>
  );

  const notice = buildProviderSignInNotice({
    id: "provider-send-preflight",
    severity: "warning",
    providerLabel: prompt.providerLabel,
    instruction: "Sign in and your held message sends by itself.",
    extraActions: isProviderSignInInFlight(signIn) ? null : confirmSignedIn,
    signIn,
    onDismiss,
  });

  if (!recheckFailed || isProviderSignInInFlight(signIn)) {
    return notice;
  }

  return {
    ...notice,
    lead: "Still signed out.",
    detail: providerSignInStatusText(signIn) ?? "The last sign-in did not complete.",
  };
}
