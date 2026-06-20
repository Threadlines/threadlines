import type { ModelSelection, ProviderInstanceId } from "@threadlines/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@threadlines/shared/model";

export const DEFAULT_CODEX_SERVICE_TIER_SELECTION = "default";

const SERVICE_TIER_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

function normalizeServiceTierId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === DEFAULT_CODEX_SERVICE_TIER_SELECTION) {
    return undefined;
  }
  return SERVICE_TIER_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function resolveCodexServiceTier(
  modelSelection: ModelSelection | null | undefined,
  options?: { readonly instanceId?: ProviderInstanceId },
): string | undefined {
  if (!modelSelection) {
    return undefined;
  }
  if (options?.instanceId !== undefined && modelSelection.instanceId !== options.instanceId) {
    return undefined;
  }

  const selectedServiceTier = normalizeServiceTierId(
    getModelSelectionStringOptionValue(modelSelection, "serviceTier"),
  );
  if (selectedServiceTier) {
    return selectedServiceTier;
  }

  return getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true
    ? "fast"
    : undefined;
}

export function resolveCodexCliServiceTier(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  const serviceTier = resolveCodexServiceTier(modelSelection);
  return serviceTier === "priority" ? "fast" : serviceTier;
}
