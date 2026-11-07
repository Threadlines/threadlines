import { buildProviderOptionSelectionsFromDescriptors } from "@threadlines/shared/model";
import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createAiSettings, type AiSettingsControl } from "~/lib/vendor/ai-settings/ai-settings.js";
import "~/lib/vendor/ai-settings/ai-settings.css";
import "./ai-provider-settings.css";
import { interactionModeOptions } from "../../interactionModeOptions";
import { runtimeModeConfig } from "../../runtimeModeOptions";
import type { ModelPickerSettingsProps, ModelPickerTraitsTarget } from "./ModelPickerSettings";
import {
  getDescriptorStringValue,
  getSwitchControlLabel,
  getTraitsSectionVisibility,
  getTraitSwitchControls,
  isFastModeControl,
  replaceDescriptorCurrentValue,
  useTraitsUpdater,
} from "./traitControls";

type Props = Pick<ModelPickerSettingsProps, "traits" | "mode"> & {
  access: ModelPickerSettingsProps["access"] | null;
  modelPicker?: ReactNode;
  placement?: "top" | "bottom" | "auto";
  modelSlot?: HTMLElement;
  /** Compact chat summary; the full editor remains in the model picker. */
  compact?: boolean;
};

function effortTone(value: string): AiSettingsControl["tone"] {
  const level = value.toLowerCase().replace(/[\s_-]/g, "");
  if (level === "extrahigh" || level === "xhigh") return "xhigh";
  if (level === "ultracode" || level === "ultra") return "ultra";
  if (level === "low" || level === "medium" || level === "high" || level === "max") return level;
  return undefined;
}

/** Threadlines owns descriptors and persistence; the shared DOM control owns its UI. */
export const AiProviderSettings = memo(function AiProviderSettings(props: Props) {
  const [modelSlot] = useState(() => document.createElement("div"));
  return (
    <>
      {props.traits ? (
        <SettingsWithTraits {...props} target={props.traits} modelSlot={modelSlot} />
      ) : (
        <SettingsView {...props} traitControls={[]} modelSlot={modelSlot} />
      )}
      {props.modelPicker ? createPortal(props.modelPicker, modelSlot) : null}
    </>
  );
});

function SettingsWithTraits(props: Props & { target: ModelPickerTraitsTarget }) {
  const { provider, instanceId, models, model, modelOptions, omitOptionIds, ...persistence } =
    props.target;
  const update = useTraitsUpdater({ provider, instanceId, model, persistence });
  const { descriptors, reasoningDescriptor, otherSelectDescriptors } = getTraitsSectionVisibility({
    provider,
    models,
    model,
    modelOptions,
    omitOptionIds,
  });
  const setValue = (id: string, value: string | boolean) =>
    update(
      buildProviderOptionSelectionsFromDescriptors(
        replaceDescriptorCurrentValue(descriptors, id, value),
      ),
    );
  const controls: AiSettingsControl[] = [];
  if (reasoningDescriptor) {
    const value = getDescriptorStringValue(reasoningDescriptor) ?? "";
    controls.push({
      id: reasoningDescriptor.id,
      label: "Effort",
      value,
      bars: reasoningDescriptor.options.findIndex((option) => option.id === value) + 1,
      barCount: reasoningDescriptor.options.length,
      iconOnly: props.compact ? "auto" : false,
      tone: effortTone(value),
      options: reasoningDescriptor.options.map((option, index) => ({
        value: option.id,
        label: option.label,
        description: option.description,
        bars: index + 1,
        barCount: reasoningDescriptor.options.length,
        tone: effortTone(option.id),
      })),
      onChange: (next) => {
        if (typeof next === "string") setValue(reasoningDescriptor.id, next);
      },
    });
  }
  for (const descriptor of otherSelectDescriptors) {
    const value = getDescriptorStringValue(descriptor) ?? "";
    if (props.compact && (descriptor.id !== "serviceTier" || !/fast|priority/i.test(value)))
      continue;
    const icon = descriptor.id === "serviceTier" ? "speed" : "settings";
    controls.push({
      id: descriptor.id,
      label: descriptor.label,
      value,
      iconOnly: props.compact,
      icon,
      options: descriptor.options.map((option) => ({
        value: option.id,
        label: option.label,
        description: option.description,
        icon,
      })),
      onChange: (next) => {
        if (typeof next === "string") setValue(descriptor.id, next);
      },
    });
  }
  for (const control of getTraitSwitchControls(descriptors)) {
    if (props.compact && (!isFastModeControl(control) || !control.checked)) continue;
    const icon = isFastModeControl(control) ? "speed" : "settings";
    controls.push({
      id: control.descriptor.id,
      label: control.label,
      value: control.checked,
      icon,
      iconOnly: props.compact,
      ...(control.descriptor.id === "ultracode" && control.checked
        ? { tone: "ultra" as const }
        : {}),
      options: [false, true].map((checked) => ({
        value: checked,
        label: getSwitchControlLabel({ ...control, checked }),
        description: control.description,
        icon,
        ...(control.descriptor.id === "ultracode" && checked ? { tone: "ultra" as const } : {}),
      })),
      onChange: (next) => {
        if (typeof next === "boolean") setValue(control.descriptor.id, control.nextValue(next));
      },
    });
  }
  return <SettingsView {...props} traitControls={controls} />;
}

function SettingsView({
  mode,
  access,
  traitControls,
  modelPicker,
  modelSlot,
  placement = "top",
  compact = false,
}: Props & { traitControls: AiSettingsControl[] }) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<ReturnType<typeof createAiSettings> | null>(null);
  const controls = [...traitControls];
  const effortIndex = controls.findIndex((control) => control.label === "Effort");
  const modeControls: AiSettingsControl[] = [];
  const accessControls: AiSettingsControl[] = [];
  if (mode)
    modeControls.push({
      id: "threadlines-mode",
      label: "Mode",
      value: mode.value,
      icon: mode.value === "plan" ? "plan" : "build",
      iconOnly: compact,
      options: interactionModeOptions.map((option) => ({
        value: option.mode,
        label: option.label,
        description: option.description,
        icon: option.mode === "plan" ? "plan" : "build",
      })),
      onChange: (value) => {
        const option = interactionModeOptions.find((entry) => entry.mode === value);
        if (option) mode.onChange(option.mode);
      },
    });
  if (access) {
    const current =
      access.options.find((option) => option.mode === access.value) ??
      runtimeModeConfig[access.value];
    accessControls.push({
      id: "threadlines-access",
      label: "Access level",
      value: access.value,
      icon: "access",
      title: access.planning
        ? "Plan turns don't edit files. This access level applies when you build."
        : current.description,
      options: access.options.map((option) => ({
        value: option.mode,
        label: option.label,
        description: option.disabledReason ?? option.description,
        disabled: option.disabled === true,
        icon: "access",
      })),
      onChange: (value) => {
        const option = access.options.find((entry) => entry.mode === value);
        if (option && !option.disabled) access.onChange(option.mode);
      },
    });
  }
  controls.splice(effortIndex + 1, 0, ...accessControls);
  if (compact) controls.push(...modeControls);
  else controls.splice(effortIndex + 1, 0, ...modeControls);
  const config = {
    label: "AI settings",
    layout: "wrap" as const,
    placement,
    controls,
    ...(modelPicker && modelSlot ? { modelSlot } : {}),
  };
  useLayoutEffect(() => {
    if (!host.current) return;
    instance.current = createAiSettings(host.current, { label: "AI settings", controls: [] });
    return () => {
      instance.current?.destroy();
      instance.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    instance.current?.update(config);
  });
  return <div className="threadlines-ai-settings" ref={host} />;
}
