import type { ProviderDriverKind } from "@t3tools/contracts";

export const PROVIDER_AUTH_RECONNECT_COMMANDS = {
  claudeAgent: "claude auth login",
  codex: "codex login",
} as const;

const AUTH_ERROR_SNIPPETS = [
  "401 invalid authentication",
  "401 unauthorized",
  "access token expired",
  "authentication credentials",
  "expired credential",
  "failed to authenticate",
  "invalid api key",
  "invalid authentication",
  "invalid authorization",
  "missing api key",
  "not authenticated",
  "not logged in",
  "requires authentication",
  "requires openai auth",
  "unauthenticated",
] as const;

export function providerAuthReconnectCommand(provider: ProviderDriverKind): string | undefined {
  return PROVIDER_AUTH_RECONNECT_COMMANDS[
    String(provider) as keyof typeof PROVIDER_AUTH_RECONNECT_COMMANDS
  ];
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
  return AUTH_ERROR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

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
