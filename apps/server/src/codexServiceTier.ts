import type { ModelSelection, ProviderInstanceId } from "@threadlines/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@threadlines/shared/model";

export const DEFAULT_CODEX_SERVICE_TIER_SELECTION = "default";

const SERVICE_TIER_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

export function resolveCodexAppServerServiceTier(
  modelSelection: ModelSelection | null | undefined,
  options?: { readonly instanceId?: ProviderInstanceId },
): string | null | undefined {
  if (!modelSelection) {
    return undefined;
  }
  if (options?.instanceId !== undefined && modelSelection.instanceId !== options.instanceId) {
    return undefined;
  }

  const rawServiceTier = getModelSelectionStringOptionValue(modelSelection, "serviceTier")?.trim();
  if (rawServiceTier) {
    if (rawServiceTier === DEFAULT_CODEX_SERVICE_TIER_SELECTION) {
      return null;
    }
    if (SERVICE_TIER_ID_PATTERN.test(rawServiceTier)) {
      return rawServiceTier;
    }
  }

  const fastMode = getModelSelectionBooleanOptionValue(modelSelection, "fastMode");
  if (fastMode === true) {
    return "fast";
  }
  if (fastMode === false) {
    return null;
  }
  return undefined;
}

export function resolveCodexServiceTier(
  modelSelection: ModelSelection | null | undefined,
  options?: { readonly instanceId?: ProviderInstanceId },
): string | undefined {
  const tier = resolveCodexAppServerServiceTier(modelSelection, options);
  return tier ?? undefined;
}

export function resolveCodexCliServiceTier(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  const serviceTier = resolveCodexServiceTier(modelSelection);
  return serviceTier === "priority" ? "fast" : serviceTier;
}
