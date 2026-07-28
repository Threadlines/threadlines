import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";

import { cn } from "~/lib/utils";

/**
 * The hover-card primitive, distinct from Tooltip on purpose.
 *
 * A tooltip names the thing under the pointer; a preview card is a surface you
 * can move onto and read. Building the thread card on Tooltip put it in the
 * same one-at-a-time group as the row's action-button tooltips, so hovering
 * "Wrap up" evicted the card for the row it belonged to -- and leaving the
 * trigger closed the card before it could be read. PreviewCard has neither
 * problem: it is groupless, and it stays open while the pointer is over the
 * popup.
 */
export const PreviewCard = PreviewCardPrimitive.Root;
export const PreviewCardTrigger = PreviewCardPrimitive.Trigger;
export const createPreviewCardHandle = PreviewCardPrimitive.createHandle;

export function PreviewCardPopup({
  className,
  side,
  sideOffset,
  align,
  children,
  ...props
}: PreviewCardPrimitive.Popup.Props & {
  side?: PreviewCardPrimitive.Positioner.Props["side"];
  sideOffset?: PreviewCardPrimitive.Positioner.Props["sideOffset"];
  align?: PreviewCardPrimitive.Positioner.Props["align"];
}) {
  return (
    <PreviewCardPrimitive.Portal>
      <PreviewCardPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        className="z-50 max-w-(--available-width)"
        data-slot="preview-card-positioner"
      >
        <PreviewCardPrimitive.Popup
          className={cn(
            "relative origin-(--transform-origin) rounded-md border bg-popover not-dark:bg-clip-padding text-popover-foreground text-xs shadow-md/5 transition-[scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
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
