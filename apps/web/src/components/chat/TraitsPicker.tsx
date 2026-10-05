import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@threadlines/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  getPromotedChoiceReplacement,
} from "@threadlines/shared/model";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { SlidersHorizontalIcon, ZapIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import { DropdownChevron } from "../ui/select";
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

function getSelectedTraits(
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

function getTraitsSectionVisibility(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  modelOptions: ProviderOptions | null | undefined;
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
  modelOptions: ProviderOptions | null | undefined;
  omitOptionIds?: ReadonlyArray<string> | undefined;
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
  iconOnly?: boolean;
  /** Options to leave out of the menu, such as Ultracode where it makes no sense. */
  omitOptionIds?: ReadonlyArray<string>;
  /** Claude is working on this thread; an active Ultracode glints while it does. */
  working?: boolean;
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  instanceId,
  models,
  model,
  modelOptions,
  omitOptionIds,
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
    omitOptionIds,
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
              {descriptor.options.map((option) => {
                const isUltracodeOption = option.id === "ultracode";
                // Speeds differ in what they cost (e.g. "8x speed, increased
                // usage"), so each one says so; other lists stay one line.
                const costNote = descriptor.id === "serviceTier" ? option.description : undefined;
                return (
                  <MenuRadioItem
                    key={option.id}
                    value={option.id}
                    className={cn(isUltracodeOption && "ultracode-menu-option")}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn(
                            "min-w-0 truncate",
                            isUltracodeOption && "ultracode-trait-label",
                          )}
                        >
                          {option.label}
                        </span>
                        {option.isDefault ? (
                          <span className="shrink-0 text-[10px] text-muted-foreground/60">
                            default
                          </span>
                        ) : null}
                      </span>
                      {costNote ? (
                        <span
                          className="truncate text-[10px] text-muted-foreground/70"
                          title={costNote}
                        >
                          {costNote}
                        </span>
                      ) : null}
                    </span>
                  </MenuRadioItem>
                );
              })}
            </MenuRadioGroup>
          </MenuGroup>
        </div>
      ))}
      {switchControls.length > 0 ? (
        <div>
          {selectDescriptors.length > 0 ? <MenuDivider /> : null}
          <MenuGroup>
            {/* Toggles stay open on click so several can be adjusted in one visit. */}
            {switchControls.map((control) => {
              const ultracodeOn = control.descriptor.id === "ultracode" && control.checked;
              return (
                <MenuCheckboxItem
                  key={control.descriptor.id}
                  variant="switch"
                  checked={control.checked}
                  title={control.description}
                  closeOnClick={false}
                  className={cn(ultracodeOn && "ultracode-menu-option")}
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
                  <span className={cn(ultracodeOn && "ultracode-trait-label")}>
                    {control.label}
                  </span>
                </MenuCheckboxItem>
              );
            })}
          </MenuGroup>
        </div>
      ) : null}
    </>
  );
});

const ULTRACODE_GLINT_INTERVAL_MS = 2000;
const ULTRACODE_GLINT_KEYFRAMES: Keyframe[] = [
  { transform: "translateX(-120%)", opacity: 0 },
  { opacity: 1, offset: 0.15 },
  { opacity: 1, offset: 0.85 },
  { transform: "translateX(120%)", opacity: 0 },
];
const ULTRACODE_GLINT_TIMING: KeyframeAnimationOptions = {
  duration: 900,
  easing: "cubic-bezier(0.4, 0, 0.2, 1)",
};

/**
 * Sends a band of light across the Ultracode trigger: once when Ultracode
 * turns on, then every 2s while Claude works. A timer starts each pass, so
 * the trigger is still between passes and nothing moves while Claude is
 * idle, the window is hidden, or the system asks for less motion.
 */
function useUltracodeGlint(active: boolean, working: boolean) {
  const bandRef = useRef<HTMLSpanElement>(null);
  const wasActive = useRef(active);
  useEffect(() => {
    const turnedOn = active && !wasActive.current;
    wasActive.current = active;
    if (!active || (!turnedOn && !working)) {
      return;
    }
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let current: Animation | undefined;
    const pass = () => {
      if (document.hidden || reducedMotion.matches) return;
      current?.cancel();
      current = bandRef.current?.animate(ULTRACODE_GLINT_KEYFRAMES, ULTRACODE_GLINT_TIMING);
    };
    pass();
    const interval = working ? window.setInterval(pass, ULTRACODE_GLINT_INTERVAL_MS) : undefined;
    return () => {
      window.clearInterval(interval);
      current?.cancel();
    };
  }, [active, working]);
  return bandRef;
}

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  instanceId,
  models,
  model,
  modelOptions,
  triggerVariant,
  triggerClassName,
  iconOnly = false,
  omitOptionIds,
  working = false,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const {
    descriptors,
    hasAnyControls,
    ultracodeEnabled: ultracodeActive,
  } = getTraitsSectionVisibility({
    provider,
    models,
    model,
    modelOptions,
    omitOptionIds,
  });
  const ultracodeGlintRef = useUltracodeGlint(ultracodeActive, working);
  if (!hasAnyControls) {
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
  // Older CLIs name the level "Ultracode"; otherwise the level comes first.
  const triggerSummary =
    ultracodeActive && primaryTriggerLabel && primaryTriggerLabel !== "Ultracode"
      ? `${primaryTriggerLabel}, Ultracode`
      : primaryTriggerLabel;
  // Ultracode shows through the trigger's own look, so its switch never
  // adds to the count.
  const renderedTraitCount =
    selectDescriptors.length +
    switchControls.filter((control) => control.descriptor.id !== "ultracode").length;
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
            size={iconOnly ? "icon-sm" : "sm"}
            variant={triggerVariant ?? "ghost"}
            aria-label={iconOnly ? `Reasoning settings: ${triggerSummary ?? "Options"}` : undefined}
            tooltip={iconOnly ? (triggerSummary ?? "Reasoning settings") : undefined}
            className={cn(
              "text-muted-foreground/70 hover:text-foreground/80 [&_svg]:mx-0",
              iconOnly
                ? "shrink-0"
                : "min-w-0 max-w-40 shrink-0 justify-start overflow-hidden whitespace-nowrap px-2 sm:max-w-48 sm:px-3",
              ultracodeActive && "ultracode-trait-trigger",
              triggerClassName,
            )}
          />
        }
      >
        {ultracodeActive ? (
          <span aria-hidden="true" className="ultracode-glint">
            <span ref={ultracodeGlintRef} className="ultracode-glint-band" />
          </span>
        ) : null}
        <span className="relative z-[1] flex min-w-0 w-full items-center justify-center gap-1.5 overflow-hidden">
          <SlidersHorizontalIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0",
              ultracodeActive && "text-[#7c3aed] dark:text-[#c9a8ff]",
            )}
          />
          {!iconOnly && primaryTriggerLabel ? (
            <span className={cn("min-w-0 truncate", ultracodeActive && "ultracode-trait-label")}>
              {primaryTriggerLabel}
            </span>
          ) : null}
          {!iconOnly && ultracodeActive && primaryTriggerLabel !== "Ultracode" ? (
            <span className="sr-only">Ultracode on</span>
          ) : null}
          {!iconOnly && activeFastModeControl ? (
            <>
              <ZapIcon aria-hidden="true" className="size-3 shrink-0 text-primary-readable" />
              <span className="sr-only">Fast Mode enabled</span>
            </>
          ) : null}
          {!iconOnly && extraTraitCount > 0 ? (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
              +{extraTraitCount}
            </span>
          ) : null}
          {!iconOnly ? <DropdownChevron solid={triggerVariant === "outline"} /> : null}
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <TraitsMenuContent
          provider={provider}
          {...(instanceId ? { instanceId } : {})}
          models={models}
          model={model}
          modelOptions={modelOptions}
          {...(omitOptionIds ? { omitOptionIds } : {})}
          {...persistence}
        />
      </MenuPopup>
    </Menu>
  );
});
