"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";
import { TooltipWrapper, type TooltipSide } from "./tooltip";

const buttonVariants = cva(
  "[&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg border font-medium text-base outline-none transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-ring disabled:pointer-events-none disabled:opacity-64 sm:text-sm [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8",
        icon: "size-9 sm:size-8",
        "icon-lg": "size-10 sm:size-9",
        "icon-sm": "size-8 sm:size-7",
        "icon-xl":
          "size-11 sm:size-10 [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        "icon-xs":
          "size-7 rounded-md before:rounded-[calc(var(--radius-md)-1px)] sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9",
        sm: "h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:h-7",
        xl: "h-11 px-[calc(--spacing(4)-1px)] text-lg sm:h-10 sm:text-base [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        xs: "h-7 gap-1 rounded-md px-[calc(--spacing(2)-1px)] text-sm before:rounded-[calc(var(--radius-md)-1px)] sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        // Solid accent: the one action that completes a form, or Send.
        default:
          "border-transparent bg-primary text-primary-foreground shadow-[inset_0_0.5px_0_rgb(255_255_255/0.25),0_1px_1.5px_rgb(0_0_0/0.25)] disabled:shadow-none [:hover,[data-pressed]]:bg-primary-hover",
        destructive:
          "border-transparent bg-destructive text-white shadow-[inset_0_0.5px_0_rgb(255_255_255/0.2),0_1px_1.5px_rgb(0_0_0/0.25)] disabled:shadow-none [:hover,[data-pressed]]:bg-destructive/90",
        // The solid button with red text: Turn off, Remove, Sign out of everything.
        "destructive-outline":
          "border-transparent bg-control text-destructive-foreground shadow-(--control-shadow) hover:bg-control-hover [:active,[data-pressed]]:not-disabled:bg-control-pressed [:active,[data-pressed]]:not-disabled:shadow-(--control-shadow-pressed)",
        // Toolbar and list controls: plain until hover.
        ghost:
          "border-transparent text-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent",
        link: "border-transparent underline-offset-4 [:hover,[data-pressed]]:underline",
        // The solid button for controls in content (settings, dialogs, panel
        // bodies, notices). The name is historical; there is no outline.
        outline:
          "border-transparent bg-control text-foreground shadow-(--control-shadow) hover:bg-control-hover [:active,[data-pressed]]:not-disabled:bg-control-pressed [:active,[data-pressed]]:not-disabled:shadow-(--control-shadow-pressed)",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [:active,[data-pressed]]:bg-secondary/80 [:hover,[data-pressed]]:bg-secondary/90",
      },
    },
  },
);

interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  /**
   * Renders the button inside the app's styled tooltip. Prefer this over the
   * native `title` attribute so tooltips stay visually consistent.
   */
  tooltip?: React.ReactNode;
  tooltipSide?: TooltipSide;
}

function Button({ className, variant, size, render, tooltip, tooltipSide, ...props }: ButtonProps) {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] = render
    ? undefined
    : "button";

  const defaultProps = {
    className: cn(buttonVariants({ className, size, variant })),
    "data-slot": "button",
    type: typeValue,
  };

  const element = useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });

  if (tooltip == null) {
    return element;
  }

  return (
    <TooltipWrapper side={tooltipSide} tooltip={tooltip}>
      {element}
    </TooltipWrapper>
  );
}

export { Button, buttonVariants };
