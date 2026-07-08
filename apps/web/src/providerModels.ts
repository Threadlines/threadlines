import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  LEGACY_RUNTIME_MODES,
  ProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  RUNTIME_MODES,
  type ModelCapabilities,
  type ModelInputModality,
  type ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  type ServerProviderModel,
} from "@threadlines/contracts";
import { createModelCapabilities, normalizeModelSlug } from "@threadlines/shared/model";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

export function formatProviderDriverKindLabel(provider: ProviderDriverKind): string {
  return (
    PROVIDER_DISPLAY_NAMES[provider] ??
    provider
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase())
  );
}

export function getProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ReadonlyArray<ServerProviderModel> {
  return getProviderSnapshot(providers, provider)?.models ?? [];
}

export function getProviderSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ServerProvider | undefined {
  const defaultInstanceId = defaultInstanceIdForDriver(provider);
  return providers.find((candidate) => candidate.instanceId === defaultInstanceId);
}

export function getProviderDisplayName(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): string {
  const snapshot = getProviderSnapshot(providers, provider);
  return snapshot?.displayName?.trim() || formatProviderDriverKindLabel(provider);
}

export function getProviderInteractionModeToggle(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): boolean {
  return getProviderSnapshot(providers, provider)?.showInteractionModeToggle ?? true;
}

/**
 * Runtime modes the driver can honor natively. Absent on the snapshot means
 * the legacy three-mode set (drivers without a native auto tier).
 */
export function getProviderSupportedRuntimeModes(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ReadonlyArray<RuntimeMode> {
  return getProviderSnapshot(providers, provider)?.supportedRuntimeModes ?? LEGACY_RUNTIME_MODES;
}

/**
 * Per-model restriction on the provider-level runtime modes. Returns the
 * modes the selected model cannot honor (for disabling, not hiding).
 */
export function getModelUnsupportedRuntimeModes(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderDriverKind,
): ReadonlyArray<RuntimeMode> {
  const slug = normalizeModelSlug(model, provider);
  const supported = models.find((candidate) => candidate.slug === slug)?.supportedRuntimeModes;
  if (!supported) {
    return [];
  }
  return RUNTIME_MODES.filter((mode) => !supported.includes(mode));
}

export function isProviderEnabled(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): boolean {
  if (providers.length === 0) {
    return true;
  }
  return getProviderSnapshot(providers, provider)?.enabled ?? false;
}

// Resolve an instance selection to the correlated live driver. If the
// instance is absent, fall back to a live enabled provider instead of
// inferring a driver from the missing instance id.
export function resolveSelectableProvider(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind | ProviderInstanceId | null | undefined,
): ProviderDriverKind {
  const requestedEntry = providers.find((candidate) => candidate.instanceId === provider);
  if (requestedEntry?.enabled) {
    return requestedEntry.driver;
  }
  return providers.find((candidate) => candidate.enabled)?.driver ?? DEFAULT_DRIVER_KIND;
}

export function getProviderModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderDriverKind,
): ModelCapabilities {
  const slug = normalizeModelSlug(model, provider);
  return models.find((candidate) => candidate.slug === slug)?.capabilities ?? EMPTY_CAPABILITIES;
}

export function getProviderModelInputModalities(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderDriverKind,
): ReadonlyArray<ModelInputModality> | undefined {
  const slug = normalizeModelSlug(model, provider);
  return models.find((candidate) => candidate.slug === slug)?.capabilities?.inputModalities;
}

export function providerModelSupportsInputModality(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderDriverKind,
  modality: ModelInputModality,
): boolean {
  const modalities = getProviderModelInputModalities(models, model, provider);
  return modalities ? modalities.includes(modality) : true;
}

export function getDefaultServerModel(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): string {
  const models = getProviderModels(providers, provider);
  const liveDefault = models.find(
    (model) => !model.isCustom && model.isHidden !== true && model.isDefault === true,
  )?.slug;
  if (liveDefault) {
    return liveDefault;
  }

  const providerDefault = DEFAULT_MODEL_BY_PROVIDER[provider];
  if (
    providerDefault &&
    models.some(
      (model) =>
        !model.isCustom &&
        model.isHidden !== true &&
        normalizeModelSlug(model.slug, provider) === providerDefault,
    )
  ) {
    return providerDefault;
  }
  return (
    models.find((model) => !model.isCustom && model.isHidden !== true)?.slug ??
    models.find((model) => model.isHidden !== true)?.slug ??
    providerDefault ??
    DEFAULT_MODEL
  );
}
