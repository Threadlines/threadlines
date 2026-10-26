"use client";

import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";

import { useOnScreenKeyboardInsetVars } from "~/hooks/useOnScreenKeyboardInset";
import { cn } from "~/lib/utils";
import { CoveringBackdrop } from "~/components/ui/noticeLayer";

/**
 * A panel that slides in from one side of the screen and that a finger can
 * push back out: swiping it toward its edge drags it along and closes it past
 * the halfway mark or on a quick flick, and a short drag springs back. Tapping outside, Escape and
 * the close controls close it as a sheet would.
 *
 * Only a finger drags it. A mouse or pen press inside the panel selects text
 * and works its controls as usual (the content sits in `Drawer.Content`), so
 * a narrow desktop window showing the same drawer behaves like a sheet.
 * Swipes that start on an element marked `data-base-ui-swipe-ignore` stay with
 * that element, so something inside the panel can own its own sideways swipe.
 */
const Drawer = DrawerPrimitive.Root;

const DrawerTitle = DrawerPrimitive.Title;

const DrawerDescription = DrawerPrimitive.Description;

/**
 * Ends the panel where an on-screen keyboard begins: iPhone Safari slides the
 * keyboard over the page instead of shrinking it, so without this a field low
 * in the panel (the source control commit message) sits under the keys.
 * Mounted while the panel is in the page (always, for a `keepMounted` one).
 */
function DrawerViewport({ className, ...props }: Omit<DrawerPrimitive.Viewport.Props, "style">) {
  const keyboardInsetVars = useOnScreenKeyboardInsetVars(true);
  return (
    <DrawerPrimitive.Viewport
      className={cn(
        "fixed inset-0 z-50 flex pt-(--keyboard-inset-top) pb-(--keyboard-inset-bottom)",
        className,
      )}
      data-slot="drawer-viewport"
      style={keyboardInsetVars}
      {...props}
    />
  );
}

/**
 * While a finger drags, the drawer writes the panel's transform itself; at
 * rest the panel sits at the drag's last offset, so opening, closing and a
 * spring back all animate that one property from wherever the finger left it.
 */
function DrawerPopup({
  className,
  children,
  side = "left",
  keepMounted = false,
  backdropProps,
  viewportClassName,
  ...props
}: DrawerPrimitive.Popup.Props & {
  side?: "left" | "right";
  /** Keeps the panel in the page while closed, so what it holds keeps its state. */
  keepMounted?: boolean;
  backdropProps?: DrawerPrimitive.Backdrop.Props | undefined;
  viewportClassName?: string | undefined;
}) {
  return (
    <DrawerPrimitive.Portal keepMounted={keepMounted}>
      <DrawerPrimitive.Backdrop
        {...backdropProps}
        className={cn(
          "fixed inset-0 z-50 bg-black/32 opacity-[calc(1-var(--drawer-swipe-progress))] backdrop-blur-sm transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 data-swiping:transition-none",
          typeof backdropProps?.className === "string" ? backdropProps.className : undefined,
        )}
        data-slot="drawer-backdrop"
        render={(renderProps, state) => <CoveringBackdrop {...renderProps} open={state.open} />}
      />
      <DrawerViewport
        className={cn(side === "left" ? "justify-start" : "justify-end", viewportClassName)}
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
          <DrawerPrimitive.Content className="flex min-h-0 flex-1 flex-col">
            {children}
          </DrawerPrimitive.Content>
        </DrawerPrimitive.Popup>
      </DrawerViewport>
    </DrawerPrimitive.Portal>
  );
}

/**
 * A thin invisible strip along the screen edge a closed drawer slides in
 * from: a finger swiping in from it pulls the drawer open, following along.
 * 12px, inside the page's own margin, so it never covers text or a button.
 * Render it inside `Drawer`, and only where nothing else owns that edge (a
 * browser's back swipe does, in a tab).
 */
function DrawerSwipeArea({
  className,
  side = "left",
  ...props
}: DrawerPrimitive.SwipeArea.Props & {
  side?: "left" | "right";
}) {
  return (
    <DrawerPrimitive.SwipeArea
      className={cn("fixed inset-y-0 z-40 w-3", side === "left" ? "left-0" : "right-0", className)}
      data-slot="drawer-swipe-area"
      {...props}
    />
  );
}

export { Drawer, DrawerDescription, DrawerPopup, DrawerSwipeArea, DrawerTitle };
