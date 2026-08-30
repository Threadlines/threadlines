import type { ProviderDriverKind } from "@threadlines/contracts";

export const PROVIDER_AUTH_RECONNECT_COMMANDS = {
  claudeAgent: "claude auth login",
  codex: "codex login",
  cursor: "agent login",
  fx: "fx login",
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
  /\brefresh token (?:has been |is |was )?revoked\b/u,
  /\brequires openai auth\b/u,
] as const;

const GENERIC_AUTH_STATUS_PATTERNS = [
  /^(?:error:\s*)?(?:(?:codex(?: cli)?|claude(?: code)?|cursor agent|openai(?: cli)?|provider|model provider)\s+is\s+)?not authenticated[.!]?(?:\s*(?:[•·-]\s*)?(?:please\s+)?run\s+(?:\/login|`[^`]+`)(?: in a terminal)?(?:, then retry| and try again)?\.?)?$/u,
  /^(?:error:\s*)?not logged in[.!]?(?:\s*(?:[•·-]\s*)?(?:please\s+)?run\s+(?:\/login|`[^`]+`)(?: in a terminal)?(?:, then retry| and try again)?\.?)?$/u,
  /^(?:error:\s*)?(?:(?:codex|claude|cursor agent|openai|provider|model provider)\s+)?requires authentication[.!]?$/u,
  /^(?:error:\s*)?unauthenticated[.!]?$/u,
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
  return (
    AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    GENERIC_AUTH_STATUS_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

export function findProviderAuthRetryUserMessageIndex(
  messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
  }>,
): number | null {
  let lastUserMessageIndex = -1;
  let lastAssistantMessageIndex = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (lastUserMessageIndex < 0 && message.role === "user") {
      lastUserMessageIndex = index;
    }
    if (lastAssistantMessageIndex < 0 && message.role === "assistant") {
      lastAssistantMessageIndex = index;
    }
    if (lastUserMessageIndex >= 0 && lastAssistantMessageIndex >= 0) {
      break;
    }
  }

  if (
    lastUserMessageIndex < 0 ||
    lastAssistantMessageIndex <= lastUserMessageIndex ||
    !isProviderAuthErrorMessage(messages[lastAssistantMessageIndex]?.text)
  ) {
    return null;
  }

  return lastUserMessageIndex;
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
