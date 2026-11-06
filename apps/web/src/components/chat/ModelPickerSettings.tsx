import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ServerProviderModel,
} from "@threadlines/contracts";
import { memo, type ReactNode } from "react";
import type { RuntimeModeOption } from "../../runtimeModeOptions";
import { AiProviderSettings } from "./AiProviderSettings";
import type { ProviderOptions, TraitsPersistence } from "./traitControls";

/** The agent whose reasoning and other options the panel edits. */
export type ModelPickerTraitsTarget = {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId | undefined;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  modelOptions?: ProviderOptions | null | undefined;
  /** Options to leave out, such as Ultracode where it makes no sense. */
  omitOptionIds?: ReadonlyArray<string> | undefined;
} & TraitsPersistence;

export interface ModelPickerSettingsProps {
  /** Null while there is no agent to set up, such as while one is being added. */
  traits: ModelPickerTraitsTarget | null;
  /** Shown in place of the agent's options while `traits` is null. */
  traitsNote?: ReactNode;
  mode: {
    value: ProviderInteractionMode;
    onChange: (mode: ProviderInteractionMode) => void;
  } | null;
  access: {
    value: RuntimeMode;
    options: ReadonlyArray<RuntimeModeOption>;
    onChange: (mode: RuntimeMode) => void;
    /** Plan turns don't edit; the level applies once the agent builds. */
    planning: boolean;
  };
}

/** Shared AI toolbar in the model panel; app values and save handlers stay controlled. */
export const ModelPickerSettings = memo(function ModelPickerSettings(
  props: ModelPickerSettingsProps,
) {
  return (
    <div
      data-model-picker-settings="true"
      className="shrink-0 border-t border-border px-3 pt-2 pb-2.5"
    >
      {!props.traits && props.traitsNote ? (
        <p className="text-xs text-muted-foreground">{props.traitsNote}</p>
      ) : null}
      <AiProviderSettings
        traits={props.traits}
        mode={props.mode}
        access={props.access}
        placement="auto"
      />
    </div>
  );
});
