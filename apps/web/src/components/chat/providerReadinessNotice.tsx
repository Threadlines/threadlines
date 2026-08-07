/**
 * The two ways an unusable provider reaches the composer notice dock.
 *
 * They arrive from two directions: after a turn already failed on a provider
 * auth error (the thread-error notice) and before a send we can tell in
 * advance will fail (ChatView's send preflight). Both directions have to read
 * the same, so the copy lives here once instead of being restated per surface.
 *
 * @module providerReadinessNotice
 */
import { Link } from "@tanstack/react-router";
import { SettingsIcon, TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { ProviderSendPreflightPrompt } from "../ChatView.logic";
import { Button } from "../ui/button";
import type { ComposerNotice } from "./composerNotices";

export function buildProviderSignInNotice({
  id,
  severity = "error",
  providerLabel,
  command,
  instruction = "complete the browser sign-in, then retry",
  detailSuffix,
  extraActions,
  onRunSignIn,
  onDismiss,
}: {
  id: string;
  severity?: ComposerNotice["severity"];
  providerLabel: string;
  command: string;
  /** Clause after the command: what happens once the sign-in lands. */
  instruction?: string;
  detailSuffix?: string;
  extraActions?: ReactNode;
  onRunSignIn?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
}): ComposerNotice {
  return {
    id,
    severity,
    lead: `${providerLabel} needs sign-in.`,
    detail: (
      <>
        Run <code className="font-mono text-foreground/85">{command}</code>, {instruction}.
        {detailSuffix ? ` ${detailSuffix}` : null}
      </>
    ),
    actions: (
      <>
        <Button size="xs" disabled={!onRunSignIn} onClick={() => onRunSignIn?.()}>
          <TerminalIcon className="size-3" />
          Sign in
        </Button>
        {extraActions}
      </>
    ),
    dismissLabel: `Dismiss ${providerLabel} sign-in notice`,
    ...(onDismiss ? { onDismiss } : {}),
  };
}

/**
 * Same shape for a provider whose CLI is missing. There is no terminal command
 * we can run for the user here, so the action routes to the place that lists
 * install and sign-in steps.
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
 * the ordinary path.
 */
export function buildProviderSendPreflightNotice({
  prompt,
  recheckFailed,
  isRechecking,
  onRunSignIn,
  onConfirmSignedIn,
  onDismiss,
}: {
  prompt: ProviderSendPreflightPrompt;
  recheckFailed: boolean;
  isRechecking: boolean;
  onRunSignIn: (prompt: ProviderSendPreflightPrompt) => void;
  onConfirmSignedIn: () => void;
  onDismiss: () => void;
}): ComposerNotice {
  // A provider that isn't installed has nothing to sign in to yet, and one
  // without a known login command has no terminal step we can name, so both
  // fall back to the install-and-connect notice.
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
    command: prompt.command,
    instruction: "then your message sends",
    extraActions: confirmSignedIn,
    onRunSignIn: () => onRunSignIn(prompt),
    onDismiss,
  });

  if (!recheckFailed) {
    return notice;
  }

  return {
    ...notice,
    lead: "Still signed out.",
    detail: "The terminal shows where the sign-in stopped.",
  };
}
