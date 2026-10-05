"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "~/lib/utils";

/**
 * The macOS-style switch: a white knob on a grey track that turns accent blue
 * when on. `size="sm"` is the dense-list size (rows of plugins, skills).
 */
function Switch({
  className,
  size = "default",
  ...props
}: SwitchPrimitive.Root.Props & { size?: "default" | "sm" }) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-[calc(var(--thumb-size)+4px)] w-[calc(var(--thumb-size)*2+2px)] shrink-0 cursor-pointer items-center rounded-full p-0.5 shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.12)] outline-none transition-[background-color,box-shadow] duration-200 focus-ring data-checked:bg-primary data-unchecked:bg-switch-off data-disabled:cursor-not-allowed data-disabled:opacity-64",
        // Phone-width screens get the bigger knob, as touch targets.
        size === "sm"
          ? "[--thumb-size:16px] sm:[--thumb-size:13px]"
          : "[--thumb-size:20px] sm:[--thumb-size:16px]",
        className,
      )}
      data-size={size}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block aspect-square h-full origin-left in-[[role=switch]:active,[data-slot=label]:active,[data-slot=field-label]:active]:not-data-disabled:scale-x-110 in-[[role=switch]:active,[data-slot=label]:active,[data-slot=field-label]:active]:rounded-[var(--thumb-size)/calc(var(--thumb-size)*1.1)] rounded-(--thumb-size) bg-white shadow-[0_0_0_0.5px_rgb(0_0_0/0.1),0_1px_2px_rgb(0_0_0/0.3)] will-change-transform [transition:translate_.15s,border-radius_.15s,scale_.1s_.1s,transform-origin_.15s] data-checked:origin-[var(--thumb-size)_50%] data-checked:translate-x-[calc(var(--thumb-size)-2px)]",
        )}
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
