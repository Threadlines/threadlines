/**
 * The two cards that explain an unusable provider above the composer.
 *
 * They are shown from two directions: after a turn already failed on a
 * provider auth error (`ThreadErrorBanner`) and before a send we can tell in
 * advance will fail (ChatView's send preflight). Both directions have to read
 * the same, so the markup and copy live here once instead of being restated
 * per surface.
 *
 * @module ProviderReadinessNotice
 */
import { Link } from "@tanstack/react-router";
import { SendHorizontalIcon, SettingsIcon, TerminalIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { ProviderSendPreflightPrompt } from "../ChatView.logic";
import { Button } from "../ui/button";
import { CompactStatusNoticeRow } from "./statusNotice";

export function DismissNoticeButton({
  label = "Dismiss error",
  onDismiss,
}: {
  label?: string;
  onDismiss: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className="inline-flex size-6 items-center justify-center rounded-md text-destructive/60 transition-colors hover:text-destructive"
      onClick={onDismiss}
    >
      <XIcon className="size-3.5" />
    </button>
  );
}

export function ProviderSignInNotice({
  providerLabel,
  command,
  retryHint = "retry",
  errorText,
  extraActions,
  onRunSignIn,
  onDismiss,
}: {
  providerLabel: string;
  command: string;
  /** Trailing clause of the instruction: "retry" after a failure, "send again" before one. */
  retryHint?: string;
  errorText?: ReactNode;
  extraActions?: ReactNode;
  onRunSignIn?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
}) {
  return (
    <CompactStatusNoticeRow
      tone="error"
      title={`${providerLabel} sign-in required`}
      message={
        <>
          Run <code className="font-mono text-foreground/85">{command}</code>, complete the browser
          sign-in, then {retryHint}.
        </>
      }
      {...(errorText !== undefined ? { errorText } : {})}
      actions={
        <>
          <Button size="xs" disabled={!onRunSignIn} onClick={() => onRunSignIn?.()}>
            <TerminalIcon className="size-3" />
            Sign in in terminal
          </Button>
          {extraActions}
          {onDismiss ? <DismissNoticeButton onDismiss={onDismiss} /> : null}
        </>
      }
    />
  );
}

/**
 * Same shape for a provider whose CLI is missing. There is no terminal command
 * we can run for the user here, so the action routes to the place that lists
 * install and sign-in steps.
 */
export function ProviderNotInstalledNotice({
  providerLabel,
  extraActions,
  onDismiss,
}: {
  providerLabel: string;
  extraActions?: ReactNode;
  onDismiss?: (() => void) | undefined;
}) {
  return (
    <CompactStatusNoticeRow
      tone="error"
      title={`${providerLabel} isn't installed`}
      message="Install it and sign in from Settings."
      actions={
        <>
          <Button size="xs" render={<Link to="/settings/providers" />}>
            <SettingsIcon className="size-3" />
            Open Settings
          </Button>
          {extraActions}
          {onDismiss ? <DismissNoticeButton onDismiss={onDismiss} /> : null}
        </>
      }
    />
  );
}

/**
 * Shown in place of a turn we held back. Nothing is ever hard-blocked: the
 * snapshot behind the verdict can be stale, so "Send anyway" dispatches the
 * turn exactly as an uninterrupted send would.
 */
export function ProviderSendPreflightNotice({
  prompt,
  onRunSignIn,
  onSendAnyway,
  onDismiss,
}: {
  prompt: ProviderSendPreflightPrompt | null;
  onRunSignIn: (prompt: ProviderSendPreflightPrompt) => void;
  onSendAnyway: () => void;
  onDismiss: () => void;
}) {
  if (!prompt) {
    return null;
  }

  const sendAnyway = (
    <Button size="xs" variant="outline" onClick={onSendAnyway}>
      <SendHorizontalIcon className="size-3" />
      Send anyway
    </Button>
  );

  // A provider that isn't installed has nothing to sign in to yet, and one
  // without a known login command has no terminal step we can name, so both
  // fall back to the install-and-connect card.
  if (prompt.reason === "notInstalled" || !prompt.command) {
    return (
      <ProviderNotInstalledNotice
        providerLabel={prompt.providerLabel}
        extraActions={sendAnyway}
        onDismiss={onDismiss}
      />
    );
  }

  return (
    <ProviderSignInNotice
      providerLabel={prompt.providerLabel}
      command={prompt.command}
      retryHint="send again"
      extraActions={sendAnyway}
      onRunSignIn={() => onRunSignIn(prompt)}
      onDismiss={onDismiss}
    />
  );
}
