import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@threadlines/contracts";
import type { ReactNode } from "react";

import type { DraftId } from "../../composerDraftStore";
import { shouldRenderTraitsControls } from "./traitControls";
import { TraitsMenuContent, TraitsPicker } from "./TraitsPicker";

export {
  getComposerProviderState,
  type ComposerProviderState,
  type ComposerProviderStateInput,
} from "./composerProviderState.logic";

type TraitsRenderInput = {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  iconOnly?: boolean;
  /** Claude is working on this thread, which lets an active Ultracode glint. */
  working?: boolean;
};

function renderTraitsControl(
  Component: typeof TraitsMenuContent | typeof TraitsPicker,
  input: TraitsRenderInput,
): ReactNode {
  const {
    provider,
    instanceId,
    threadRef,
    draftId,
    model,
    models,
    modelOptions,
    iconOnly,
    working,
  } = input;
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
      {...(iconOnly !== undefined ? { iconOnly } : {})}
      {...(working !== undefined ? { working } : {})}
    />
  );
}

export function renderProviderTraitsMenuContent(input: TraitsRenderInput): ReactNode {
  return renderTraitsControl(TraitsMenuContent, input);
}

export function renderProviderTraitsPicker(input: TraitsRenderInput): ReactNode {
  return renderTraitsControl(TraitsPicker, input);
}
