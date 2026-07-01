import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode, Ref } from "react";

import { cn } from "~/lib/utils";

const TooltipCreateHandle = TooltipPrimitive.createHandle;

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipPopup({
  className,
  popupRef,
  positionerClassName,
  align = "center",
  collisionAvoidance,
  collisionPadding,
  sideOffset = 4,
  side = "top",
  anchor,
  children,
  positionMethod,
  sticky,
  ...props
}: TooltipPrimitive.Popup.Props & {
  align?: TooltipPrimitive.Positioner.Props["align"];
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
  anchor?: TooltipPrimitive.Positioner.Props["anchor"];
  collisionAvoidance?: TooltipPrimitive.Positioner.Props["collisionAvoidance"];
  collisionPadding?: TooltipPrimitive.Positioner.Props["collisionPadding"];
  popupRef?: Ref<HTMLDivElement> | undefined;
  positionMethod?: TooltipPrimitive.Positioner.Props["positionMethod"];
  positionerClassName?: string | undefined;
  sticky?: TooltipPrimitive.Positioner.Props["sticky"];
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
        collisionPadding={collisionPadding}
        className={cn(
          "z-50 h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none",
          positionerClassName,
        )}
        data-slot="tooltip-positioner"
        positionMethod={positionMethod}
        side={side}
        sideOffset={sideOffset}
        sticky={sticky}
      >
        <TooltipPrimitive.Popup
          ref={popupRef}
          className={cn(
            "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-balance rounded-md border bg-popover not-dark:bg-clip-padding text-popover-foreground text-xs shadow-md/5 transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            className,
          )}
          data-slot="tooltip-popup"
          {...props}
        >
          <TooltipPrimitive.Viewport
            className="relative size-full overflow-clip px-(--viewport-inline-padding) py-1 [--viewport-inline-padding:--spacing(2)] data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:truncate **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity"
            data-slot="tooltip-viewport"
          >
            {children}
          </TooltipPrimitive.Viewport>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

type TooltipSide = TooltipPrimitive.Positioner.Props["side"];

/**
 * Wraps a single interactive element in the app's styled tooltip. Prefer the
 * `tooltip` prop on `Button`/`Toggle`; reach for this directly only when
 * attaching a styled tooltip to a bare element that has no `tooltip` prop.
 * Always use this over the native `title` attribute, which renders an
 * unstyled OS tooltip.
 */
function TooltipWrapper({
  tooltip,
  side,
  align,
  sideOffset,
  children,
}: {
  tooltip: ReactNode;
  side?: TooltipSide;
  align?: TooltipPrimitive.Positioner.Props["align"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup align={align} side={side} sideOffset={sideOffset}>
        {typeof tooltip === "string" ? <p>{tooltip}</p> : tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}

export {
  TooltipCreateHandle,
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
  TooltipWrapper,
};
export type { TooltipSide };
