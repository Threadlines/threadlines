/**
 * AcpProviderModels — turns ACP `configOptions` into Threadlines models and
 * option descriptors, and app option selections back into ACP updates.
 *
 * The generic mapping mirrors every non-model, non-mode option one-to-one:
 * a `select` becomes a select descriptor keyed by the option id, a
 * `boolean` becomes a toggle. Vendors whose options need renaming (Cursor)
 * supply their own `AcpModelOptionMapping`.
 *
 * @module provider/acp/AcpProviderModels
 */
import type {
  ModelCapabilities,
  ProviderOptionDescriptor,
  ServerProviderModel,
} from "@threadlines/contracts";
import {
  createModelCapabilities,
  getProviderOptionSelectionValue,
} from "@threadlines/shared/model";
import type * as EffectAcpSchema from "effect-acp/schema";

import { buildBooleanOptionDescriptor, buildSelectOptionDescriptor } from "../providerSnapshot.ts";
import type { AcpConfigUpdate, AcpModelOptionMapping } from "./AcpProviderDescriptor.ts";
import { findModelConfigOption } from "./AcpRuntimeModel.ts";

export const EMPTY_ACP_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

export interface AcpSelectChoice {
  readonly value: string;
  readonly name: string;
}

export function flattenSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<AcpSelectChoice> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value.trim(), name: entry.name.trim() } satisfies AcpSelectChoice]
      : entry.options.map(
          (option) =>
            ({ value: option.value.trim(), name: option.name.trim() }) satisfies AcpSelectChoice,
        ),
  );
}

export function selectConfigOptionCurrentValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): string | undefined {
  if (!configOption || configOption.type !== "select") {
    return undefined;
  }
  return configOption.currentValue?.trim() || undefined;
}

/** Mode-style options are driven by the runtime mode, never by the model picker. */
function isSessionControlOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  return option.category === "mode" || option.id.trim().toLowerCase() === "mode";
}

export const GENERIC_ACP_MODEL_OPTION_MAPPING: AcpModelOptionMapping = {
  capabilitiesFromConfigOptions: (configOptions) => {
    const modelOption = findModelConfigOption(configOptions);
    const optionDescriptors: Array<ProviderOptionDescriptor> = [];
    for (const option of configOptions) {
      if (option === modelOption || isSessionControlOption(option)) {
        continue;
      }
      const label = option.name.trim() || option.id;
      const description = option.description?.trim() || undefined;
      if (option.type === "boolean") {
        optionDescriptors.push(
          buildBooleanOptionDescriptor({
            id: option.id,
            label,
            currentValue: option.currentValue,
            ...(description ? { description } : {}),
          }),
        );
        continue;
      }
      if (option.type !== "select") {
        continue;
      }
      const choices = flattenSessionConfigSelectOptions(option);
      if (choices.length === 0) {
        continue;
      }
      const currentValue = selectConfigOptionCurrentValue(option);
      optionDescriptors.push(
        buildSelectOptionDescriptor({
          id: option.id,
          label,
          options: choices.map((choice) => ({
            value: choice.value,
            label: choice.name || choice.value,
            ...(choice.value === currentValue ? { isDefault: true } : {}),
          })),
          ...(description ? { description } : {}),
        }),
      );
    }
    return createModelCapabilities({ optionDescriptors });
  },
  configUpdatesFromSelections: (configOptions, selections) => {
    if (!selections || selections.length === 0) {
      return [];
    }
    const modelOption = findModelConfigOption(configOptions);
    const updates: Array<AcpConfigUpdate> = [];
    for (const option of configOptions) {
      if (option === modelOption || isSessionControlOption(option)) {
        continue;
      }
      const requested = getProviderOptionSelectionValue(selections, option.id);
      if (requested === undefined) {
        continue;
      }
      if (option.type === "boolean") {
        if (typeof requested === "boolean") {
          updates.push({ configId: option.id, value: requested });
        }
        continue;
      }
      if (option.type !== "select" || typeof requested !== "string") {
        continue;
      }
      const match = flattenSessionConfigSelectOptions(option).find(
        (choice) => choice.value === requested.trim(),
      );
      if (match) {
        updates.push({ configId: option.id, value: match.value });
      }
    }
    return updates;
  },
};

export function hasAcpModelCapabilities(model: Pick<ServerProviderModel, "capabilities">): boolean {
  return (model.capabilities?.optionDescriptors?.length ?? 0) > 0;
}

export function buildAcpDiscoveredModels(
  discovered: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    readonly capabilities: ModelCapabilities;
  }>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return discovered.flatMap((model) => {
    const slug = model.slug.trim();
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities: model.capabilities,
      } satisfies ServerProviderModel,
    ];
  });
}

/**
 * Models advertised by a session's `configOptions`. The current model gets
 * the capabilities derived from the live option set; other entries share
 * them when `sharedCapabilities` is set, otherwise they wait for a per-model
 * probe.
 */
export function buildAcpModelsFromConfigOptions(input: {
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined;
  readonly mapping: AcpModelOptionMapping;
  readonly sharedCapabilities: boolean;
}): ReadonlyArray<ServerProviderModel> {
  const configOptions = input.configOptions ?? [];
  const modelOption = findModelConfigOption(configOptions);
  const choices = flattenSessionConfigSelectOptions(modelOption);
  if (!modelOption || choices.length === 0) {
    return [];
  }
  const currentValue = selectConfigOptionCurrentValue(modelOption);
  const currentCapabilities = input.mapping.capabilitiesFromConfigOptions(configOptions);
  return buildAcpDiscoveredModels(
    choices.map((choice) => ({
      slug: choice.value,
      name: choice.name,
      capabilities:
        input.sharedCapabilities || currentValue === choice.value
          ? currentCapabilities
          : EMPTY_ACP_MODEL_CAPABILITIES,
    })),
  );
}
