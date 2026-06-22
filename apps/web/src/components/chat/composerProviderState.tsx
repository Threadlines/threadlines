import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@threadlines/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@threadlines/shared/model";
import type { ReactNode } from "react";

import type { DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { shouldRenderTraitsControls, TraitsMenuContent, TraitsPicker } from "./TraitsPicker";

export type ComposerProviderStateInput = {
  provider: ProviderDriverKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  prompt: string;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
};

export type ComposerProviderState = {
  provider: ProviderDriverKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ReadonlyArray<ProviderOptionSelection> | undefined;
  // Display label of the selected `contextWindow` option (e.g. "200k"),
  // when the model exposes one. Lets the composer show the window size
  // before the first context-window activity arrives.
  contextWindowLabel: string | null;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

type TraitsRenderInput = {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
};

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  const { provider, model, models, modelOptions } = input;
  const caps = getProviderModelCapabilities(models, model, provider);
  const descriptors = getProviderOptionDescriptors({ caps, selections: modelOptions });
  const primarySelectDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<(typeof descriptors)[number], { type: "select" }> =>
      descriptor.type === "select",
  );
  const primaryValue = getProviderOptionCurrentValue(primarySelectDescriptor ?? null);
  const promptEffort = typeof primaryValue === "string" ? primaryValue : null;
  const contextWindowDescriptor =
    descriptors.find(
      (descriptor) => descriptor.type === "select" && descriptor.id === "contextWindow",
    ) ?? null;
  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: buildProviderOptionSelectionsFromDescriptors(descriptors),
    contextWindowLabel: getProviderOptionCurrentLabel(contextWindowDescriptor) ?? null,
  };
}

function renderTraitsControl(
  Component: typeof TraitsMenuContent | typeof TraitsPicker,
  input: TraitsRenderInput,
): ReactNode {
  const { provider, instanceId, threadRef, draftId, model, models, modelOptions } = input;
  const hasTarget = threadRef !== undefined || draftId !== undefined;
  if (!hasTarget || !shouldRenderTraitsControls({ provider, models, model, modelOptions })) {
    return null;
  }
  return (
    <Component
      provider={provider}
      {...(instanceId ? { instanceId } : {})}
      models={models}
      {...(threadRef ? { threadRef } : {})}
      {...(draftId ? { draftId } : {})}
      model={model}
      modelOptions={modelOptions}
    />
  );
}

export function renderProviderTraitsMenuContent(input: TraitsRenderInput): ReactNode {
  return renderTraitsControl(TraitsMenuContent, input);
}

export function renderProviderTraitsPicker(input: TraitsRenderInput): ReactNode {
  return renderTraitsControl(TraitsPicker, input);
}
