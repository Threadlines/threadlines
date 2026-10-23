"use client";

import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";

import { cn } from "~/lib/utils";

/**
 * A panel that slides in from one side of the screen and that a finger can
 * push back out: swiping it toward its edge drags it along and closes it past
 * the halfway mark or on a quick flick, and a short drag springs back. Tapping outside, Escape and
 * the close controls close it as a sheet would.
 *
 * Swipes that start on an element marked `data-base-ui-swipe-ignore` stay with
 * that element, so something inside the panel can own its own sideways swipe.
 */
const Drawer = DrawerPrimitive.Root;

const DrawerTitle = DrawerPrimitive.Title;

const DrawerDescription = DrawerPrimitive.Description;

/**
 * While a finger drags, the drawer writes the panel's transform itself; at
 * rest the panel sits at the drag's last offset, so opening, closing and a
 * spring back all animate that one property from wherever the finger left it.
 */
function DrawerPopup({
  className,
  children,
  side = "left",
  ...props
}: DrawerPrimitive.Popup.Props & {
  side?: "left" | "right";
}) {
  return (
    <DrawerPrimitive.Portal>
      <DrawerPrimitive.Backdrop
        className="fixed inset-0 z-50 bg-black/32 opacity-[calc(1-var(--drawer-swipe-progress))] backdrop-blur-sm transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 data-swiping:transition-none"
        data-slot="drawer-backdrop"
      />
      <DrawerPrimitive.Viewport
        className={cn("fixed inset-0 z-50 flex", side === "left" ? "justify-start" : "justify-end")}
        data-slot="drawer-viewport"
      >
        <DrawerPrimitive.Popup
          className={cn(
            "relative flex h-full min-h-0 flex-col bg-popover text-popover-foreground elevate-overlay outline-none [transform:translateX(var(--drawer-swipe-movement-x))] transition-transform duration-200 ease-out",
            side === "left"
              ? "border-e data-ending-style:[transform:translateX(-100%)] data-starting-style:[transform:translateX(-100%)]"
              : "border-s data-ending-style:[transform:translateX(100%)] data-starting-style:[transform:translateX(100%)]",
            className,
          )}
          data-slot="drawer-popup"
          {...props}
        >
          {children}
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPrimitive.Portal>
  );
}

export { Drawer, DrawerDescription, DrawerPopup, DrawerTitle };
