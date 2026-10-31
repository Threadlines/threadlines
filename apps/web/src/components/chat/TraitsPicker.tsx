import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@threadlines/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
} from "@threadlines/shared/model";
import { memo, useEffect, useRef, useState } from "react";
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
import { cn } from "~/lib/utils";
import {
  getDescriptorStringValue,
  getRenderedSelectDescriptors,
  getSwitchControlLabel,
  getTraitSwitchControls,
  getTraitsSectionVisibility,
  isFastModeControl,
  replaceDescriptorCurrentValue,
  type ProviderOptions,
  type TraitsPersistence,
  useTraitsUpdater,
} from "./traitControls";

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
  const updateModelOptions = useTraitsUpdater({ provider, instanceId, model, persistence });
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
export function useUltracodeGlint(active: boolean, working: boolean) {
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
