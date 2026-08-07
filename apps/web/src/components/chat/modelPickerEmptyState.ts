/**
 * Empty-state copy for the model picker.
 *
 * A fresh install has providers configured but not installed or not signed
 * in, so the picker's list is empty for a reason the user can act on. These
 * helpers turn the provider snapshots the client already holds into the
 * lines shown in place of the bare "No models match" / "No models
 * available" text, reusing the settings page's status language
 * (`getProviderSummary`) so both surfaces describe a provider the same way.
 *
 * @module modelPickerEmptyState
 */
import type { ServerProvider } from "@threadlines/contracts";

import { getProviderSummary } from "../settings/providerStatus";

/** Why a configured provider cannot currently serve models. */
export type ModelPickerProviderAvailability = "available" | "notInstalled" | "notAuthenticated";

/**
 * The slice of a `ProviderInstanceEntry` the empty state needs. Declared
 * structurally so entries pass through unchanged and tests can build a
 * minimal fixture.
 */
export interface ModelPickerProviderState {
  readonly displayName: string;
  readonly driverKind: string;
  readonly enabled: boolean;
  readonly snapshot: ServerProvider;
}

export interface ModelPickerEmptyState {
  /** One line per rendered message; always at least one entry. */
  readonly lines: ReadonlyArray<string>;
  /**
   * True when the lines point at something the user fixes in provider
   * settings, so the picker should offer the "Open Settings" action.
   */
  readonly showSettingsAction: boolean;
}

/**
 * `unknown` auth is treated as available: the server has not contradicted
 * the credential, and nagging about a provider we cannot judge is worse
 * than saying nothing.
 */
export function getModelPickerProviderAvailability(
  provider: ServerProvider,
): ModelPickerProviderAvailability {
  if (!provider.installed) {
    return "notInstalled";
  }
  const chatCapability = provider.auth.capabilities?.chat?.status;
  if (chatCapability === "verified" || chatCapability === "configured") {
    return "available";
  }
  if (chatCapability === "unavailable" || provider.auth.status === "unauthenticated") {
    return "notAuthenticated";
  }
  return "available";
}

/**
 * Loose match between a search query and a provider: the query is a
 * case-insensitive substring of either the driver kind (`claudeAgent`) or
 * the instance display name ("Claude Personal"). Typing "claude" when
 * Claude is missing should explain the absence rather than say nothing.
 */
function matchesProviderQuery(provider: ModelPickerProviderState, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return false;
  }
  return (
    provider.driverKind.toLowerCase().includes(normalizedQuery) ||
    provider.displayName.toLowerCase().includes(normalizedQuery)
  );
}

function unavailableProviderLine(provider: ModelPickerProviderState): string {
  return getModelPickerProviderAvailability(provider.snapshot) === "notInstalled"
    ? `${provider.displayName} isn't installed. Install it and sign in from Settings.`
    : `${provider.displayName} needs sign-in. Connect it from Settings.`;
}

export function resolveModelPickerEmptyState(input: {
  /** Raw search box contents; blank means the user is browsing tabs. */
  readonly searchQuery: string;
  readonly activeTabKind: "favorites" | "instance" | null;
  readonly providers: ReadonlyArray<ModelPickerProviderState>;
}): ModelPickerEmptyState {
  const query = input.searchQuery.trim();
  if (query.length > 0) {
    const unavailableMatches = input.providers.filter(
      (provider) =>
        matchesProviderQuery(provider, query) &&
        getModelPickerProviderAvailability(provider.snapshot) !== "available",
    );
    if (unavailableMatches.length === 0) {
      return { lines: ["No models match"], showSettingsAction: false };
    }
    return {
      lines: unavailableMatches.map(unavailableProviderLine),
      showSettingsAction: true,
    };
  }

  if (input.activeTabKind === "favorites") {
    return { lines: ["No favorite models"], showSettingsAction: false };
  }

  // Nothing to pick and every provider the user enabled is unusable: name
  // each one instead of leaving them to guess which is broken.
  const enabledProviders = input.providers.filter((provider) => provider.enabled);
  const unavailableProviders = enabledProviders.filter(
    (provider) => getModelPickerProviderAvailability(provider.snapshot) !== "available",
  );
  if (enabledProviders.length > 0 && unavailableProviders.length === enabledProviders.length) {
    return {
      lines: unavailableProviders.map(
        (provider) => `${provider.displayName} · ${getProviderSummary(provider.snapshot).headline}`,
      ),
      showSettingsAction: true,
    };
  }

  return { lines: ["No models available"], showSettingsAction: false };
}
