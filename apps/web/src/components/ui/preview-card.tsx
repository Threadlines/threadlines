"use client";

import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";

import { cn } from "~/lib/utils";

const PreviewCard = PreviewCardPrimitive.Root;

function PreviewCardTrigger(props: PreviewCardPrimitive.Trigger.Props) {
  return <PreviewCardPrimitive.Trigger data-slot="preview-card-trigger" {...props} />;
}

/**
 * Hover surface for rows that had to truncate. Styled off the popover so a
 * preview reads as the same class of surface, with the scale/opacity entrance
 * Base UI drives from `data-starting-style` / `data-ending-style`.
 */
function PreviewCardPopup({
  children,
  className,
  positionerClassName,
  side = "right",
  align = "start",
  sideOffset = 8,
  ...props
}: PreviewCardPrimitive.Popup.Props & {
  side?: PreviewCardPrimitive.Positioner.Props["side"];
  align?: PreviewCardPrimitive.Positioner.Props["align"];
  sideOffset?: PreviewCardPrimitive.Positioner.Props["sideOffset"];
  positionerClassName?: string;
}) {
  return (
    <PreviewCardPrimitive.Portal>
      <PreviewCardPrimitive.Positioner
        align={align}
        className={cn(
          "z-50 max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none",
          positionerClassName,
        )}
        data-slot="preview-card-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <PreviewCardPrimitive.Popup
          className={cn(
            "relative origin-(--transform-origin) rounded-lg border bg-popover not-dark:bg-clip-padding p-3 text-popover-foreground elevate-popover outline-none",
            "transition-[transform,scale,opacity] duration-150 ease-out",
            "data-starting-style:scale-97 data-starting-style:opacity-0",
            "data-ending-style:scale-97 data-ending-style:opacity-0",
            className,
          )}
          data-slot="preview-card-popup"
          {...props}
        >
          {children}
        </PreviewCardPrimitive.Popup>
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}

export { PreviewCard, PreviewCardPopup, PreviewCardTrigger };
