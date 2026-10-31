/**
 * The model options an agent offers (reasoning, speed, thinking, Ultracode,
 * context window) read as controls: which one is the reasoning level, which
 * toggle, and how a pick turns back into option selections. Shared by the
 * composer's settings panel and the traits menu Settings and reviews use.
 */
import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@threadlines/contracts";
import {
  findReasoningOptionDescriptor,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  getPromotedChoiceReplacement,
} from "@threadlines/shared/model";
import { useCallback } from "react";
import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";

export type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;
export type SelectProviderOptionDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
export type BooleanProviderOptionDescriptor = Extract<
  ProviderOptionDescriptor,
  { type: "boolean" }
>;

export type BinaryServiceTierToggle = {
  descriptor: SelectProviderOptionDescriptor;
  standardValue: string;
  fastValue: string;
  fastDescription?: string;
  checked: boolean;
};

export type TraitSwitchControl =
  | {
      type: "boolean";
      descriptor: BooleanProviderOptionDescriptor;
      label: string;
      description?: string;
      checked: boolean;
      nextValue: (checked: boolean) => boolean;
    }
  | {
      type: "serviceTier";
      descriptor: SelectProviderOptionDescriptor;
      label: string;
      description?: string;
      checked: boolean;
      nextValue: (checked: boolean) => string;
    };

export type TraitsPersistence =
  | {
      threadRef?: ScopedThreadRef;
      draftId?: DraftId;
      onModelOptionsChange?: never;
    }
  | {
      threadRef?: undefined;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

export function replaceDescriptorCurrentValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
  currentValue: string | boolean | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.map((descriptor) =>
    descriptor.id !== descriptorId
      ? descriptor
      : descriptor.type === "boolean"
        ? {
            ...descriptor,
            ...(typeof currentValue === "boolean" ? { currentValue } : {}),
          }
        : {
            ...descriptor,
            ...(typeof currentValue === "string" ? { currentValue } : {}),
          },
  );
}

export function getDescriptorStringValue(
  descriptor: SelectProviderOptionDescriptor | null,
): string | null {
  if (!descriptor) {
    return null;
  }
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : null;
}

function optionLooksLikeFastTier(option: SelectProviderOptionDescriptor["options"][number]) {
  const searchable = `${option.id} ${option.label}`.toLowerCase();
  return /\bfast\b/u.test(searchable) || /\bpriority\b/u.test(searchable);
}

export function getBinaryServiceTierToggle(
  descriptor: SelectProviderOptionDescriptor,
): BinaryServiceTierToggle | null {
  if (descriptor.id !== "serviceTier" || descriptor.options.length !== 2) {
    return null;
  }

  const standardOption =
    descriptor.options.find((option) => option.id === "default") ??
    descriptor.options.find((option) => option.label.toLowerCase() === "standard") ??
    descriptor.options.find((option) => option.isDefault);
  if (!standardOption) {
    return null;
  }

  const fastOption = descriptor.options.find((option) => option.id !== standardOption.id);
  if (!fastOption || !optionLooksLikeFastTier(fastOption)) {
    return null;
  }

  return {
    descriptor,
    standardValue: standardOption.id,
    fastValue: fastOption.id,
    ...(fastOption.description ? { fastDescription: fastOption.description } : {}),
    checked: getDescriptorStringValue(descriptor) === fastOption.id,
  };
}

export function getRenderedSelectDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<SelectProviderOptionDescriptor> {
  return descriptors.filter(
    (descriptor): descriptor is SelectProviderOptionDescriptor =>
      descriptor.type === "select" && getBinaryServiceTierToggle(descriptor) === null,
  );
}

export function getTraitSwitchControls(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<TraitSwitchControl> {
  return descriptors.flatMap((descriptor): ReadonlyArray<TraitSwitchControl> => {
    if (descriptor.type === "boolean") {
      return [
        {
          type: "boolean",
          descriptor,
          label: descriptor.label,
          ...(descriptor.description ? { description: descriptor.description } : {}),
          checked: descriptor.currentValue === true,
          nextValue: (checked) => checked,
        },
      ];
    }

    const serviceTierToggle = getBinaryServiceTierToggle(descriptor);
    if (!serviceTierToggle) {
      return [];
    }
    const description = descriptor.description ?? serviceTierToggle.fastDescription;

    return [
      {
        type: "serviceTier",
        descriptor,
        label: "Fast Mode",
        ...(description ? { description } : {}),
        checked: serviceTierToggle.checked,
        nextValue: (checked) =>
          checked ? serviceTierToggle.fastValue : serviceTierToggle.standardValue,
      },
    ];
  });
}

export function getSwitchControlLabel(control: TraitSwitchControl): string {
  if (control.type === "serviceTier" || control.descriptor.id === "fastMode") {
    return control.checked ? "Fast" : "Normal";
  }
  return `${control.label} ${control.checked ? "on" : "off"}`;
}

export function isFastModeControl(control: TraitSwitchControl): boolean {
  return control.type === "serviceTier" || control.descriptor.id === "fastMode";
}

/**
 * Leaves out options by id, whether they are their own control or a choice
 * inside a select. Older Claude CLIs offer Ultracode as an effort choice, so
 * omitting "ultracode" has to cover both shapes.
 */
function omitOptions(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  omitOptionIds: ReadonlyArray<string> | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  if (!omitOptionIds || omitOptionIds.length === 0) {
    return descriptors;
  }
  return descriptors.flatMap((descriptor): ReadonlyArray<ProviderOptionDescriptor> => {
    if (omitOptionIds.includes(descriptor.id)) {
      return [];
    }
    if (descriptor.type !== "select") {
      return [descriptor];
    }
    const { currentValue, ...rest } = descriptor;
    const options = descriptor.options.filter((option) => !omitOptionIds.includes(option.id));
    // A saved "ultracode" effort keeps the Extra High it stood for.
    const keptValue =
      currentValue && omitOptionIds.includes(currentValue)
        ? getPromotedChoiceReplacement(descriptor.id, currentValue)
        : currentValue;
    return [
      {
        ...rest,
        options,
        ...(keptValue && options.some((option) => option.id === keptValue)
          ? { currentValue: keptValue }
          : {}),
      },
    ];
  });
}

export function getSelectedTraits(
  provider: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  modelOptions: ProviderOptions | null | undefined,
  omitOptionIds?: ReadonlyArray<string>,
) {
  const caps = getProviderModelCapabilities(models, model, provider);
  const descriptors = omitOptions(
    getProviderOptionDescriptors({
      caps,
      selections: modelOptions,
    }),
    omitOptionIds,
  );
  const selectDescriptors = getRenderedSelectDescriptors(descriptors);
  const booleanDescriptors = descriptors.filter(
    (descriptor): descriptor is BooleanProviderOptionDescriptor => descriptor.type === "boolean",
  );
  const primarySelectDescriptor = selectDescriptors[0] ?? null;
  // The first select is not always the reasoning level (a model can offer
  // only a context window), so the level is looked up by its id.
  const reasoningDescriptor = findReasoningOptionDescriptor(selectDescriptors) ?? null;
  const otherSelectDescriptors = selectDescriptors.filter(
    (descriptor) => descriptor !== reasoningDescriptor,
  );
  const contextWindowDescriptor =
    selectDescriptors.find((descriptor) => descriptor.id === "contextWindow") ?? null;
  const agentDescriptor = selectDescriptors.find((descriptor) => descriptor.id === "agent") ?? null;
  const fastModeDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const serviceTierToggle =
    descriptors
      .filter(
        (descriptor): descriptor is SelectProviderOptionDescriptor => descriptor.type === "select",
      )
      .map(getBinaryServiceTierToggle)
      .find((toggle) => toggle !== null) ?? null;
  const thinkingDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "thinking") ?? null;
  const ultracodeDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "ultracode") ?? null;

  const effort = getDescriptorStringValue(primarySelectDescriptor);
  // Older Claude CLIs offer Ultracode as the last effort level instead.
  const ultracodeEnabled = effort === "ultracode" || ultracodeDescriptor?.currentValue === true;
  const thinkingEnabled =
    typeof thinkingDescriptor?.currentValue === "boolean" ? thinkingDescriptor.currentValue : null;
  const fastModeEnabled =
    typeof fastModeDescriptor?.currentValue === "boolean" ? fastModeDescriptor.currentValue : false;
  const contextWindow = getDescriptorStringValue(contextWindowDescriptor);
  const selectedAgent = getDescriptorStringValue(agentDescriptor);
  const selectedAgentLabel = agentDescriptor
    ? getProviderOptionCurrentLabel(agentDescriptor)
    : null;

  return {
    caps,
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    reasoningDescriptor,
    otherSelectDescriptors,
    contextWindowDescriptor,
    agentDescriptor,
    fastModeDescriptor,
    serviceTierToggle,
    thinkingDescriptor,
    effort,
    ultracodeEnabled,
    thinkingEnabled,
    fastModeEnabled,
    contextWindow,
    selectedAgent,
    selectedAgentLabel,
  };
}

export function getTraitsSectionVisibility(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  modelOptions?: ProviderOptions | null | undefined;
  omitOptionIds?: ReadonlyArray<string> | undefined;
}) {
  const selected = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    input.modelOptions,
    input.omitOptionIds,
  );

  const showEffort = selected.primarySelectDescriptor !== null;
  const showThinking = selected.thinkingDescriptor !== null;
  const showFastMode = selected.fastModeDescriptor !== null || selected.serviceTierToggle !== null;
  const showContextWindow = selected.contextWindowDescriptor !== null;
  const showAgent = selected.agentDescriptor !== null;

  return {
    ...selected,
    showEffort,
    showThinking,
    showFastMode,
    showContextWindow,
    showAgent,
    hasAnyControls: showEffort || showThinking || showFastMode || showContextWindow || showAgent,
  };
}

export function shouldRenderTraitsControls(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  modelOptions?: ProviderOptions | null | undefined;
  omitOptionIds?: ReadonlyArray<string> | undefined;
}): boolean {
  return getTraitsSectionVisibility(input).hasAnyControls;
}

/**
 * Writes a traits pick back where the agent keeps it: a thread's or draft's
 * composer state (sticky for the next turn), or a caller's own handler (an
 * added room agent, a Settings field).
 */
export function useTraitsUpdater(input: {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId | undefined;
  model: string | null | undefined;
  persistence: TraitsPersistence;
}): (nextOptions: ProviderOptions | undefined) => void {
  const { provider, instanceId, model, persistence } = input;
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  return useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if ("onModelOptionsChange" in persistence) {
        persistence.onModelOptionsChange(nextOptions);
        return;
      }
      const threadTarget = persistence.threadRef ?? persistence.draftId;
      if (!threadTarget) {
        return;
      }
      setProviderModelOptions(threadTarget, provider, nextOptions, {
        ...(instanceId ? { instanceId } : {}),
        model,
        persistSticky: true,
      });
    },
    [instanceId, model, persistence, provider, setProviderModelOptions],
  );
}
