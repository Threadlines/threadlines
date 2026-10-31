import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderOptionDescriptor,
  RuntimeMode,
  ServerProviderModel,
} from "@threadlines/contracts";
import { buildProviderOptionSelectionsFromDescriptors } from "@threadlines/shared/model";
import { memo, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { interactionModeOptions } from "../../interactionModeOptions";
import { runtimeModeConfig, type RuntimeModeOption } from "../../runtimeModeOptions";
import { SegmentedControl, SegmentedControlItem } from "../ui/segmented-control";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { EffortMeter } from "./EffortMeter";
import {
  getDescriptorStringValue,
  getTraitsSectionVisibility,
  getTraitSwitchControls,
  replaceDescriptorCurrentValue,
  type ProviderOptions,
  type TraitsPersistence,
  useTraitsUpdater,
} from "./traitControls";

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

const ROW_LABEL_CLASS = "w-12 shrink-0 text-xs text-muted-foreground pointer-coarse:w-14";

/**
 * The rows under the model list in the composer's settings button: the
 * agent's effort and other options, then the chat's Build/Plan mode and its
 * access level. Picking here never moves focus back to the prompt, so several
 * settings can change in one visit; the popup closes on its own terms.
 */
export const ModelPickerSettings = memo(function ModelPickerSettings(props: {
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
}) {
  return (
    <div
      data-model-picker-settings="true"
      className="flex shrink-0 flex-col gap-2 border-t border-border px-3 pt-2 pb-2.5"
    >
      {props.traits ? (
        <TraitRows target={props.traits} />
      ) : props.traitsNote ? (
        <p className="text-xs text-muted-foreground">{props.traitsNote}</p>
      ) : null}
      <div className="flex min-w-0 items-center gap-2.5">
        {props.mode ? (
          <>
            <span className={ROW_LABEL_CLASS}>Mode</span>
            <SegmentedControl
              size="sm"
              aria-label="Mode"
              value={props.mode.value}
              onValueChange={props.mode.onChange}
            >
              {interactionModeOptions.map((option) => {
                const Icon = option.icon;
                return (
                  <SegmentedControlItem
                    key={option.mode}
                    value={option.mode}
                    title={option.description}
                    data-mode-option={option.mode}
                  >
                    <Icon aria-hidden="true" />
                    {option.label}
                  </SegmentedControlItem>
                );
              })}
            </SegmentedControl>
          </>
        ) : null}
        <AccessSelect {...props.access} />
      </div>
    </div>
  );
});

function AccessSelect(props: {
  value: RuntimeMode;
  options: ReadonlyArray<RuntimeModeOption>;
  onChange: (mode: RuntimeMode) => void;
  planning: boolean;
}) {
  const current = props.options.find((option) => option.mode === props.value) ?? {
    mode: props.value,
    ...runtimeModeConfig[props.value],
  };
  const CurrentIcon = current.icon;
  return (
    <span className="ms-auto flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-xs text-muted-foreground">Access</span>
      <Select
        value={props.value}
        onValueChange={(value) => {
          // Shown is the level the chat runs at, which can differ from the
          // one chosen: picking it pins it, so only an empty value is skipped.
          if (value) props.onChange(value);
        }}
      >
        <SelectTrigger
          size="xs"
          className={cn("w-auto min-w-0 max-w-44", props.planning && "opacity-65")}
          aria-label={`Access level: ${current.label}`}
          title={
            props.planning
              ? "Plan turns don't edit files. This access level applies when you build."
              : current.description
          }
        >
          <CurrentIcon aria-hidden="true" className="size-3.5" />
          <SelectValue>{current.label}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false} matchTriggerWidth={false} align="end">
          {props.options.map((option) => {
            const OptionIcon = option.icon;
            return (
              <SelectItem
                key={option.mode}
                value={option.mode}
                disabled={option.disabled === true}
                className="min-w-64 py-2"
              >
                <div className="grid min-w-0 gap-0.5">
                  <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                    <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    {option.label}
                  </span>
                  <span className="text-muted-foreground text-xs leading-4">
                    {option.disabled && option.disabledReason
                      ? option.disabledReason
                      : option.description}
                  </span>
                </div>
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>
    </span>
  );
}

/**
 * The agent's own options: its reasoning level as the effort meter, any other
 * choice list (speed, context window, agent) as a dropdown, and the toggles
 * (Fast Mode, Thinking, Ultracode) as switches.
 */
function TraitRows(props: { target: ModelPickerTraitsTarget }) {
  const { provider, instanceId, models, model, modelOptions, omitOptionIds, ...persistence } =
    props.target;
  const updateModelOptions = useTraitsUpdater({
    provider,
    instanceId,
    model,
    persistence: persistence as TraitsPersistence,
  });
  const { descriptors, reasoningDescriptor, otherSelectDescriptors } = getTraitsSectionVisibility({
    provider,
    models,
    model,
    modelOptions,
    omitOptionIds,
  });
  const switchControls = getTraitSwitchControls(descriptors);
  const setValue = (descriptorId: string, value: string | boolean) =>
    updateModelOptions(
      buildProviderOptionSelectionsFromDescriptors(
        replaceDescriptorCurrentValue(descriptors, descriptorId, value),
      ),
    );

  return (
    <>
      {reasoningDescriptor ? (
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={ROW_LABEL_CLASS}>Effort</span>
          <EffortMeter
            label={reasoningDescriptor.label || "Effort"}
            options={reasoningDescriptor.options}
            value={getDescriptorStringValue(reasoningDescriptor)}
            onChange={(id) => setValue(reasoningDescriptor.id, id)}
          />
        </div>
      ) : null}
      {otherSelectDescriptors.map((descriptor) => (
        <OptionSelectRow
          key={descriptor.id}
          descriptor={descriptor}
          onChange={(value) => setValue(descriptor.id, value)}
        />
      ))}
      {switchControls.length > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
          {switchControls.map((control) => {
            const ultracodeOn = control.descriptor.id === "ultracode" && control.checked;
            return (
              <label
                key={control.descriptor.id}
                title={control.description}
                className="inline-flex cursor-pointer items-center gap-2 text-xs text-foreground"
              >
                <Switch
                  size="sm"
                  checked={control.checked}
                  onCheckedChange={(checked) =>
                    setValue(control.descriptor.id, control.nextValue(checked === true))
                  }
                />
                <span className={cn(ultracodeOn && "ultracode-trait-label")}>{control.label}</span>
              </label>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

function OptionSelectRow(props: {
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>;
  onChange: (value: string) => void;
}) {
  const { descriptor } = props;
  const value = getDescriptorStringValue(descriptor) ?? "";
  const current = descriptor.options.find((option) => option.id === value);
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className={ROW_LABEL_CLASS}>{descriptor.label}</span>
      <Select
        value={value}
        onValueChange={(next) => {
          if (typeof next === "string" && next) props.onChange(next);
        }}
      >
        <SelectTrigger size="xs" className="w-auto min-w-0 max-w-56" aria-label={descriptor.label}>
          <SelectValue>{current?.label ?? "Default"}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false} matchTriggerWidth={false}>
          {descriptor.options.map((option) => (
            <SelectItem key={option.id} value={option.id} className="py-1.5">
              <span className="flex min-w-0 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{option.label}</span>
                  {option.isDefault ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground">default</span>
                  ) : null}
                </span>
                {/* Speeds differ in what they cost, so each says so. */}
                {descriptor.id === "serviceTier" && option.description ? (
                  <span className="truncate text-[10px] text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}
