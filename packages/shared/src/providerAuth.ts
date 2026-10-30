import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerProvider,
} from "@threadlines/contracts";

import { BROWSER_SIGN_IN_DRIVERS, GUIDED_SIGN_IN_DRIVERS } from "./providerAuthCommands.ts";

export const PROVIDER_AUTH_RECONNECT_COMMANDS = {
  claudeAgent: "claude auth login",
  codex: "codex login",
  cursor: "cursor-agent login",
  fx: "fx login",
  opencode: "opencode auth login --standalone",
  muse: "muse login",
} as const;

const AUTH_ERROR_PATTERNS = [
  /\b401\s+invalid authentication\b/u,
  /\b401\s+unauthorized\b/u,
  /\baccess token expired\b/u,
  /\bauthentication credentials\b/u,
  /\bexpired credential\b/u,
  /\binvalid api key\b/u,
  /\binvalid authentication\b/u,
  /\binvalid authorization\b/u,
  /\bmissing api key\b/u,
  /\brefresh token (?:has been |is |was )?revoked\b/u,
  // Codex's every failed sign-in renewal: the refresh token expired, was
  // already used (another Codex renewed first), was revoked, or the user has
  // since signed in to another account.
  /\baccess token could not be refreshed\b/u,
  /\brequires openai auth\b/u,
] as const;

/**
 * Claude Code words every request the service refused as "Failed to
 * authenticate", a 401 and a 403 alike. A 403 is the service refusing an
 * account it recognized (a model the account has no access to, an
 * organization rule), so signing in again does not fix it.
 */
const FAILED_TO_AUTHENTICATE_PATTERN = /\bfailed to authenticate\b/u;
const FORBIDDEN_API_ERROR_PATTERN = /\bapi error: 403\b/u;

const GENERIC_AUTH_STATUS_PATTERNS = [
  /^(?:error:\s*)?(?:(?:codex(?: cli)?|claude(?: code)?|cursor agent|openai(?: cli)?|provider|model provider)\s+is\s+)?not authenticated[.!]?(?:\s*(?:[•·-]\s*)?(?:please\s+)?run\s+(?:\/login|`[^`]+`)(?: in a terminal)?(?:, then retry| and try again)?\.?)?$/u,
  /^(?:error:\s*)?not logged in[.!]?(?:\s*(?:[•·-]\s*)?(?:please\s+)?run\s+(?:\/login|`[^`]+`)(?: in a terminal)?(?:, then retry| and try again)?\.?)?$/u,
  /^(?:error:\s*)?(?:(?:codex|claude|cursor agent|openai|provider|model provider)\s+)?requires authentication[.!]?$/u,
  /^(?:error:\s*)?unauthenticated[.!]?$/u,
  // The ACP providers' own status line (fx, Cursor Agent, Grok).
  /^(?:error:\s*)?(?:cursor agent|fx) isn't signed in(?: to [a-z .]+?)?\. use sign in, or run `[^`]+` in a terminal\.$/u,
  /^(?:error:\s*)?grok isn't signed in\. use sign in\.$/u,
] as const;

export function providerAuthReconnectCommand(provider: ProviderDriverKind): string | undefined {
  return PROVIDER_AUTH_RECONNECT_COMMANDS[
    String(provider) as keyof typeof PROVIDER_AUTH_RECONNECT_COMMANDS
  ];
}

/**
 * Whether Threadlines can run this provider's sign-in itself: its terminal
 * login command, a sign-in the agent runs in the browser (Antigravity), or
 * one whose questions Threadlines asks (Pi).
 */
export function providerCanSignIn(provider: ProviderDriverKind): boolean {
  return (
    providerAuthReconnectCommand(provider) !== undefined ||
    BROWSER_SIGN_IN_DRIVERS.has(String(provider)) ||
    GUIDED_SIGN_IN_DRIVERS.has(String(provider))
  );
}

/**
 * The same, for a provider as the server reports it. A community agent says
 * for itself how it signs in: Threadlines can when one of the methods it
 * offers is one Threadlines can run.
 */
export function serverProviderCanSignIn(provider: {
  readonly driver: ServerProvider["driver"];
  readonly community?: ServerProvider["community"] | undefined;
}): boolean {
  return (
    providerCanSignIn(provider.driver) || (provider.community?.signIn.selected ?? null) !== null
  );
}

export function providerAuthReconnectHint(provider: ProviderDriverKind): string | undefined {
  const command = providerAuthReconnectCommand(provider);
  return command ? `Run \`${command}\` in a terminal, then retry.` : undefined;
}

export function isProviderAuthErrorMessage(message: string | null | undefined): boolean {
  const trimmed = message?.trim();
  if (!trimmed) {
    return false;
  }

  const normalized = trimmed.toLowerCase();
  return (
    AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    (FAILED_TO_AUTHENTICATE_PATTERN.test(normalized) &&
      !FORBIDDEN_API_ERROR_PATTERN.test(normalized)) ||
    GENERIC_AUTH_STATUS_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

/** The hint `addProviderAuthHint` puts after a sign-in error. */
// No leading \s* in the pattern: on a long run of spaces it would retry from each one.
const AUTH_HINT_SUFFIX_PATTERN = /Run `[^`]+` in a terminal, then retry\.\s*$/u;

export function addProviderAuthHint(provider: ProviderDriverKind, message: string): string {
  const trimmed = message.trim();
  if (!trimmed || !isProviderAuthErrorMessage(trimmed)) {
    return message;
  }

  const hint = providerAuthReconnectHint(provider);
  if (!hint || trimmed.includes(hint)) {
    return trimmed;
  }

  return `${trimmed} ${hint}`;
}

/**
 * Whether any line of `text` is a sign-in error, read past the "Run `…` in
 * a terminal, then retry." hint Threadlines adds after one.
 */
export function hasProviderAuthError(text: string | null | undefined): boolean {
  return (text ?? "").split("\n").some((line) => {
    const withoutHint = line.replace(AUTH_HINT_SUFFIX_PATTERN, "").trimEnd();
    return isProviderAuthErrorMessage(withoutHint) || isProviderAuthErrorMessage(line);
  });
}

/** Why a provider can't run a turn on its computer now, as its server reports it. */
export type ProviderNotReady = "turned_off" | "not_installed" | "signed_out";

/** Null when nothing the server reports says it can't (or it reported nothing). */
export function providerNotReady(
  provider: Pick<ServerProvider, "enabled" | "installed" | "auth"> | undefined,
): ProviderNotReady | null {
  if (provider === undefined) return null;
  if (!provider.enabled) return "turned_off";
  if (!provider.installed) return "not_installed";
  if (
    provider.auth.status === "unauthenticated" ||
    provider.auth.capabilities?.chat?.status === "unavailable"
  ) {
    return "signed_out";
  }
  return null;
}

/** The provider's name as people know it: its own, else its kind's, else `fallback`. */
export function providerAgentName(
  provider: Pick<ServerProvider, "displayName" | "driver"> | undefined,
  fallback: string,
): string {
  return (
    provider?.displayName ??
    (provider === undefined ? undefined : PROVIDER_DISPLAY_NAMES[provider.driver]) ??
    fallback
  );
}

/** "Claude isn't signed in on Denys's MacBook Pro.": what is wrong, by name. */
export function providerNotReadySentence(
  reason: ProviderNotReady,
  agent: string,
  computer: string,
): string {
  switch (reason) {
    case "turned_off":
      return `${agent} is turned off on ${computer}.`;
    case "not_installed":
      return `${agent} isn't installed on ${computer}.`;
    case "signed_out":
      return `${agent} isn't signed in on ${computer}.`;
  }
}

/** Where the user fixes it, as an instruction: "Sign in under Settings › Providers". */
export const PROVIDER_NOT_READY_FIX: Record<ProviderNotReady, string> = {
  turned_off: "Turn it on under Settings › Providers",
  not_installed: "Set it up under Settings › Providers",
  signed_out: "Sign in under Settings › Providers",
};
