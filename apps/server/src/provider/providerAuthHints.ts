import type { ProviderDriverKind } from "@t3tools/contracts";

const PROVIDER_AUTH_HINTS = {
  claudeAgent: "Run `claude auth login` in a terminal, then retry.",
  codex: "Run `codex login` in a terminal, then retry.",
} as const;

const AUTH_ERROR_SNIPPETS = [
  "401 invalid authentication",
  "401 unauthorized",
  "authentication credentials",
  "failed to authenticate",
  "invalid api key",
  "invalid authentication",
  "missing api key",
  "not authenticated",
  "not logged in",
  "requires authentication",
  "requires openai auth",
  "unauthenticated",
] as const;

function providerAuthHint(provider: ProviderDriverKind): string | undefined {
  return PROVIDER_AUTH_HINTS[String(provider) as keyof typeof PROVIDER_AUTH_HINTS];
}

function looksLikeAuthError(message: string): boolean {
  const normalized = message.toLowerCase();
  return AUTH_ERROR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

export function addProviderAuthHint(provider: ProviderDriverKind, message: string): string {
  const trimmed = message.trim();
  if (!trimmed || !looksLikeAuthError(trimmed)) {
    return message;
  }

  const hint = providerAuthHint(provider);
  if (!hint || trimmed.includes(hint)) {
    return trimmed;
  }

  return `${trimmed} ${hint}`;
}
