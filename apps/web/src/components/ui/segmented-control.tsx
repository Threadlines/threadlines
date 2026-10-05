"use client";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import type * as React from "react";

import { cn } from "~/lib/utils";
import { TooltipWrapper, type TooltipSide } from "./tooltip";

/**
 * Two to four options that switch a filter or a mode: a pressed-in track whose
 * chosen option is a raised solid piece. One option is always chosen; clicking
 * it again does nothing. Open-ended option lists (accounts, projects) belong in
 * a dropdown instead (docs/design/design-language.md).
 */
function SegmentedControl<Value extends string>({
  value,
  onValueChange,
  size = "default",
  className,
  ...props
}: Omit<
  ToggleGroupPrimitive.Props<Value>,
  "value" | "defaultValue" | "onValueChange" | "multiple"
> & {
  value: Value;
  onValueChange: (value: Value) => void;
  size?: "default" | "sm";
}) {
  return (
    <ToggleGroupPrimitive<Value>
      value={[value]}
      onValueChange={(next) => {
        const chosen = next[0];
        if (chosen !== undefined && chosen !== value) onValueChange(chosen);
      }}
      className={cn(
        "group/segmented inline-flex w-fit min-w-0 shrink-0 items-center gap-px rounded-lg bg-segmented-track p-0.5 shadow-(--segmented-track-shadow)",
        className,
      )}
      data-size={size}
      data-slot="segmented-control"
      {...props}
    />
  );
}

function SegmentedControlItem({
  className,
  tooltip,
  tooltipSide,
  ...props
}: TogglePrimitive.Props & {
  /** For icon-only options: the styled tooltip naming the option. */
  tooltip?: React.ReactNode;
  tooltipSide?: TooltipSide;
}) {
  const element = (
    <TogglePrimitive
      className={cn(
        // On touch screens each option keeps a 44px-tall hit area of its own width.
        "relative inline-flex h-6 min-w-0 cursor-pointer select-none items-center justify-center gap-1.5 rounded-md px-2.5 font-medium text-[12.5px] text-muted-foreground outline-none transition-[background-color,color,box-shadow] focus-ring hover:text-foreground pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:w-full disabled:pointer-events-none disabled:opacity-64 data-pressed:bg-control data-pressed:text-foreground data-pressed:shadow-(--control-shadow) group-data-[size=sm]/segmented:h-5 group-data-[size=sm]/segmented:px-2 group-data-[size=sm]/segmented:text-xs [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      data-slot="segmented-control-item"
      {...props}
    />
  );
  if (tooltip == null) return element;
  return (
    <TooltipWrapper side={tooltipSide} tooltip={tooltip}>
      {element}
    </TooltipWrapper>
  );
}

export { SegmentedControl, SegmentedControlItem };
