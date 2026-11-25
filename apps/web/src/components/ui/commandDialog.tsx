"use client";

import { Dialog as CommandDialogPrimitive } from "@base-ui/react/dialog";
import type * as React from "react";
import { cn } from "~/lib/utils";
import { useMainAreaCenterStyle } from "~/mainAreaLayout";
import { CoveringBackdrop } from "~/components/ui/noticeLayer";
import { VIEWPORT_SIDE_STRIPS_CLASS_NAME } from "~/sideStrips";

/**
 * Dialog shell and trigger primitives for command-style modals (CommandPalette,
 * AddProjectDialog, CodexSessionImportDialog). Kept separate from `command.tsx`
 * so startup entry points do not pull `autocomplete.tsx` and `@base-ui/react/combobox`
 * into the startup bundle.
 */
const CommandDialog = CommandDialogPrimitive.Root;

const CommandDialogPortal = CommandDialogPrimitive.Portal;

const CommandCreateHandle = CommandDialogPrimitive.createHandle;

function CommandDialogTrigger(props: CommandDialogPrimitive.Trigger.Props) {
  return <CommandDialogPrimitive.Trigger data-slot="command-dialog-trigger" {...props} />;
}

function CommandDialogBackdrop({ className, ...props }: CommandDialogPrimitive.Backdrop.Props) {
  return (
    <CommandDialogPrimitive.Backdrop
      className={cn(
        "fixed inset-0 z-50 bg-background/60 transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      data-slot="command-dialog-backdrop"
      {...props}
      render={(renderProps, state) => <CoveringBackdrop {...renderProps} open={state.open} />}
    />
  );
}

/**
 * Centers the palette over the page beside the sidebar, not the whole window,
 * and off the screen's side strips. A phone puts it under the top edge.
 */
function CommandDialogViewport({
  className,
  ...props
}: Omit<CommandDialogPrimitive.Viewport.Props, "style">) {
  const mainAreaCenterStyle = useMainAreaCenterStyle();
  return (
    <CommandDialogPrimitive.Viewport
      className={cn(
        "pointer-events-none fixed inset-0 z-50 flex flex-col items-center pt-[max(--spacing(2),env(safe-area-inset-top))] pb-4 sm:py-[10vh]",
        VIEWPORT_SIDE_STRIPS_CLASS_NAME,
        // A phone: the box runs nearly the window's width, right under its top edge.
        "max-sm:[--side-gutter:--spacing(2)]",
        className,
      )}
      data-slot="command-dialog-viewport"
      style={mainAreaCenterStyle}
      {...props}
    />
  );
}

function CommandDialogPopup({
  className,
  children,
  onBackdropPointerDown,
  ...props
}: CommandDialogPrimitive.Popup.Props & {
  onBackdropPointerDown?: React.PointerEventHandler<HTMLDivElement>;
}) {
  return (
    <CommandDialogPortal>
      <CommandDialogBackdrop onPointerDown={onBackdropPointerDown} />
      <CommandDialogViewport>
        <CommandDialogPrimitive.Popup
          className={cn(
            "pointer-events-auto center-on-main-area transform-[translateY(calc(-1.25rem*var(--nested-dialogs)))] relative row-start-2 flex min-h-0 w-full min-w-0 max-w-160 scale-[calc(1-0.1*var(--nested-dialogs))] flex-col overflow-hidden rounded-4xl border bg-popover not-dark:bg-clip-padding text-popover-foreground opacity-[calc(1-0.1*var(--nested-dialogs))] elevate-overlay outline-none transition-[scale,opacity,transform] duration-200 ease-in-out will-change-transform data-nested:data-ending-style:transform-[translateY(--spacing(8))] data-nested:data-starting-style:transform-[translateY(--spacing(8))] data-nested-dialog-open:origin-top data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
            className,
          )}
          data-slot="command-dialog-popup"
          {...props}
        >
          {children}
        </CommandDialogPrimitive.Popup>
      </CommandDialogViewport>
    </CommandDialogPortal>
  );
}

export { CommandCreateHandle, CommandDialog, CommandDialogPopup, CommandDialogTrigger };
