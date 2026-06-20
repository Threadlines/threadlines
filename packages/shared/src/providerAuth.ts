import type { ProviderDriverKind } from "@threadlines/contracts";

export const PROVIDER_AUTH_RECONNECT_COMMANDS = {
  claudeAgent: "claude auth login",
  codex: "codex login",
} as const;

const AUTH_ERROR_PATTERNS = [
  /\b401\s+invalid authentication\b/u,
  /\b401\s+unauthorized\b/u,
  /\baccess token expired\b/u,
  /\bauthentication credentials\b/u,
  /\bexpired credential\b/u,
  /\bfailed to authenticate\b/u,
  /\binvalid api key\b/u,
  /\binvalid authentication\b/u,
  /\binvalid authorization\b/u,
  /\bmissing api key\b/u,
  /\bnot authenticated\b/u,
  /\bnot logged in\b/u,
  /\brequires authentication\b/u,
  /\brequires openai auth\b/u,
  /^\s*(error:\s*)?unauthenticated[.!]?\s*$/u,
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
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(normalized));
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
