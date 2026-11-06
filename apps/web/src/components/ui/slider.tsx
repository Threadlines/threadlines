"use client";

import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "~/lib/utils";

/**
 * The slider: a thin track filled with the accent up to a white knob, the
 * switch's knob. `mark` puts a small tick on the track at a value worth
 * coming back to (a default). `size="sm"` is the dense size, for strips and
 * toolbars. Phone-width screens get the bigger knob, as touch targets.
 */
function Slider({
  className,
  size = "default",
  mark,
  "aria-label": ariaLabel,
  getAriaValueText,
  ...props
}: SliderPrimitive.Root.Props<number> & {
  readonly size?: "default" | "sm" | undefined;
  readonly mark?: number | undefined;
  readonly "aria-label"?: string | undefined;
  readonly getAriaValueText?: ((formattedValue: string, value: number) => string) | undefined;
}) {
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  return (
    <SliderPrimitive.Root
      className={cn(
        "relative flex w-full touch-none select-none items-center data-disabled:opacity-64",
        size === "sm"
          ? "[--thumb-size:16px] sm:[--thumb-size:13px]"
          : "[--thumb-size:20px] sm:[--thumb-size:16px]",
        className,
      )}
      data-size={size}
      data-slot="slider"
      {...props}
    >
      <SliderPrimitive.Control className="flex h-(--thumb-size) w-full cursor-pointer items-center data-disabled:cursor-not-allowed">
        <SliderPrimitive.Track className="relative h-1 w-full rounded-full bg-switch-off">
          <SliderPrimitive.Indicator className="rounded-full bg-primary" />
          {mark === undefined ? null : (
            <span
              aria-hidden
              data-slot="slider-mark"
              className="pointer-events-none absolute top-1/2 h-2.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground"
              style={{ left: `${((mark - min) / (max - min)) * 100}%` }}
            />
          )}
          <SliderPrimitive.Thumb
            aria-label={ariaLabel}
            getAriaValueText={getAriaValueText ?? null}
            className="size-(--thumb-size) rounded-full bg-white shadow-[0_0_0_0.5px_rgb(0_0_0/0.1),0_1px_2px_rgb(0_0_0/0.3)] outline-none focus-ring-within"
            data-slot="slider-thumb"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
