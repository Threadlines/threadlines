import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import { memo, useCallback, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon, SlidersHorizontalIcon, ZapIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { SectionLabel } from "../ui/threadline";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { cn } from "~/lib/utils";

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;
type SelectProviderOptionDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type BooleanProviderOptionDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

type BinaryServiceTierToggle = {
  descriptor: SelectProviderOptionDescriptor;
  standardValue: string;
  fastValue: string;
  fastDescription?: string;
  checked: boolean;
};

type TraitSwitchControl =
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

type TraitsPersistence =
  | {
      threadRef?: ScopedThreadRef;
      draftId?: DraftId;
      onModelOptionsChange?: never;
    }
  | {
      threadRef?: undefined;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

function replaceDescriptorCurrentValue(
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

function getDescriptorStringValue(
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

function getBinaryServiceTierToggle(
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

function getRenderedSelectDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<SelectProviderOptionDescriptor> {
  return descriptors.filter(
    (descriptor): descriptor is SelectProviderOptionDescriptor =>
      descriptor.type === "select" && getBinaryServiceTierToggle(descriptor) === null,
  );
}

function getTraitSwitchControls(
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

function getSwitchControlLabel(control: TraitSwitchControl): string {
  if (control.type === "serviceTier" || control.descriptor.id === "fastMode") {
    return control.checked ? "Fast" : "Normal";
  }
  return `${control.label} ${control.checked ? "on" : "off"}`;
}

function isFastModeControl(control: TraitSwitchControl): boolean {
  return control.type === "serviceTier" || control.descriptor.id === "fastMode";
}

function getSelectedTraits(
  provider: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  modelOptions: ProviderOptions | null | undefined,
) {
  const caps = getProviderModelCapabilities(models, model, provider);
  const descriptors = getProviderOptionDescriptors({
    caps,
    selections: modelOptions,
  });
  const selectDescriptors = getRenderedSelectDescriptors(descriptors);
  const booleanDescriptors = descriptors.filter(
    (descriptor): descriptor is BooleanProviderOptionDescriptor => descriptor.type === "boolean",
  );
  const primarySelectDescriptor = selectDescriptors[0] ?? null;
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

  const effort = getDescriptorStringValue(primarySelectDescriptor);
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
    contextWindowDescriptor,
    agentDescriptor,
    fastModeDescriptor,
    serviceTierToggle,
    thinkingDescriptor,
    effort,
    thinkingEnabled,
    fastModeEnabled,
    contextWindow,
    selectedAgent,
    selectedAgentLabel,
  };
}

function getTraitsSectionVisibility(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  modelOptions: ProviderOptions | null | undefined;
}) {
  const selected = getSelectedTraits(input.provider, input.models, input.model, input.modelOptions);

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
  modelOptions: ProviderOptions | null | undefined;
}): boolean {
  return getTraitsSectionVisibility(input).hasAnyControls;
}

export interface TraitsMenuContentProps {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  modelOptions?: ProviderOptions | null | undefined;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  instanceId,
  models,
  model,
  modelOptions,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const updateModelOptions = useCallback(
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
  const { descriptors, selectDescriptors, hasAnyControls } = getTraitsSectionVisibility({
    provider,
    models,
    model,
    modelOptions,
  });
  const switchControls = getTraitSwitchControls(descriptors);
  const updateDescriptors = (nextDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => {
    updateModelOptions(buildProviderOptionSelectionsFromDescriptors(nextDescriptors));
  };

  const handleSelectChange = (
    descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
    value: string,
  ) => {
    if (!value) return;
    updateDescriptors(replaceDescriptorCurrentValue(descriptors, descriptor.id, value));
  };

  if (!hasAnyControls) {
    return null;
  }

  return (
    <>
      {selectDescriptors.map((descriptor, index) => (
        <div key={descriptor.id}>
          {index > 0 ? <MenuDivider /> : null}
          <MenuGroup>
            <SectionLabel className="px-2 pt-2 pb-1">{descriptor.label}</SectionLabel>
            <MenuRadioGroup
              value={getDescriptorStringValue(descriptor) ?? ""}
              onValueChange={(value) => handleSelectChange(descriptor, value)}
            >
              {descriptor.options.map((option) => (
                <MenuRadioItem key={option.id} value={option.id}>
                  {option.label}
                  {option.isDefault ? (
                    <span className="ml-1 text-[10px] text-muted-foreground/60">default</span>
                  ) : null}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </div>
      ))}
      {switchControls.length > 0 ? (
        <div>
          {selectDescriptors.length > 0 ? <MenuDivider /> : null}
          <MenuGroup>
            {/* Toggles stay open on click so several can be adjusted in one visit. */}
            {switchControls.map((control) => (
              <MenuCheckboxItem
                key={control.descriptor.id}
                variant="switch"
                checked={control.checked}
                title={control.description}
                closeOnClick={false}
                onCheckedChange={(checked) => {
                  updateDescriptors(
                    replaceDescriptorCurrentValue(
                      descriptors,
                      control.descriptor.id,
                      control.nextValue(checked === true),
                    ),
                  );
                }}
              >
                {control.label}
              </MenuCheckboxItem>
            ))}
          </MenuGroup>
        </div>
      ) : null}
    </>
  );
});

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  instanceId,
  models,
  model,
  modelOptions,
  triggerVariant,
  triggerClassName,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { descriptors } = getTraitsSectionVisibility({
    provider,
    models,
    model,
    modelOptions,
  });
  if (
    !shouldRenderTraitsControls({
      provider,
      models,
      model,
      modelOptions,
    })
  ) {
    return null;
  }

  // The trigger shows only the primary trait; remaining settings collapse to
  // a count and live inside the menu, so stacked options never flood the bar.
  const selectDescriptors = getRenderedSelectDescriptors(descriptors);
  const primarySelectDescriptor = selectDescriptors[0] ?? null;
  const switchControls = getTraitSwitchControls(descriptors);
  const firstSwitchControl = switchControls[0] ?? null;
  const activeFastModeControl = switchControls.find(
    (control) => isFastModeControl(control) && control.checked,
  );
  const primaryTriggerLabel = primarySelectDescriptor
    ? getProviderOptionCurrentLabel(primarySelectDescriptor)
    : firstSwitchControl
      ? getSwitchControlLabel(firstSwitchControl)
      : null;
  const renderedTraitCount = selectDescriptors.length + switchControls.length;
  const fastModeRepresentedByPrimaryLabel =
    primarySelectDescriptor === null && activeFastModeControl === firstSwitchControl;
  const representedTraitCount =
    1 + (activeFastModeControl && !fastModeRepresentedByPrimaryLabel ? 1 : 0);
  const extraTraitCount = Math.max(0, renderedTraitCount - representedTraitCount);

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={triggerVariant ?? "ghost"}
            className={cn(
              "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:max-w-48 sm:px-3 [&_svg]:mx-0",
              triggerClassName,
            )}
          />
        }
      >
        <span className="flex min-w-0 w-full items-center gap-1.5 overflow-hidden">
          <SlidersHorizontalIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
          {primaryTriggerLabel ? (
            <span className="min-w-0 truncate">{primaryTriggerLabel}</span>
          ) : null}
          {activeFastModeControl ? (
            <>
              <ZapIcon aria-hidden="true" className="size-3 shrink-0 text-primary-readable" />
              <span className="sr-only">Fast Mode enabled</span>
            </>
          ) : null}
          {extraTraitCount > 0 ? (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
              +{extraTraitCount}
            </span>
          ) : null}
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <TraitsMenuContent
          provider={provider}
          {...(instanceId ? { instanceId } : {})}
          models={models}
          model={model}
          modelOptions={modelOptions}
          {...persistence}
        />
      </MenuPopup>
    </Menu>
  );
});
