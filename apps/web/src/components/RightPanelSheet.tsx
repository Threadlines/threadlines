import { type CSSProperties, type ReactNode } from "react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import {
  RIGHT_PANEL_RAIL_SHEET_CLASS_NAME,
  RIGHT_PANEL_RAIL_WIDTH,
  RIGHT_PANEL_SHEET_BACKDROP_CLASS_NAME,
  RIGHT_PANEL_SHEET_CLASS_NAME,
  RIGHT_PANEL_SHEET_VIEWPORT_CLASS_NAME,
} from "../rightPanelLayout";
import { Drawer, DrawerPopup } from "./ui/drawer";

const SHEET_CLASS_NAME_BY_SIZE = {
  default: RIGHT_PANEL_SHEET_CLASS_NAME,
  rail: RIGHT_PANEL_RAIL_SHEET_CLASS_NAME,
} as const;

/**
 * The right panel when the window is too narrow to hold it beside the chat:
 * it slides over the conversation from the right, and a finger can push it
 * back out to close it, the way the phone's sidebar closes to the left.
 */
export function RightPanelSheet(props: {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  size?: keyof typeof SHEET_CLASS_NAME_BY_SIZE;
}) {
  const size = props.size ?? "default";

  return (
    <Drawer
      open={props.open}
      swipeDirection="right"
      // Both sizes start below the chat header so its toggles keep working
      // while a panel is open (source control list and diff drill-in alike).
      // That needs a non-modal dialog (the header must stay interactive) with
      // pointer dismissal disabled: an outside-press dismissal on a header
      // toggle would close the sheet before the toggle's click reopens it.
      // The backdrop closes it explicitly instead.
      modal={false}
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <DrawerPopup
        side="right"
        keepMounted
        viewportClassName={RIGHT_PANEL_SHEET_VIEWPORT_CLASS_NAME}
        backdropProps={{
          className: RIGHT_PANEL_SHEET_BACKDROP_CLASS_NAME,
          onClick: props.onClose,
        }}
        className={cn(
          SHEET_CLASS_NAME_BY_SIZE[size],
          isElectron && "pe-[var(--app-window-resize-edge-inset)]",
        )}
        style={{ "--right-panel-rail-width": `${RIGHT_PANEL_RAIL_WIDTH}px` } as CSSProperties}
      >
        {props.children}
      </DrawerPopup>
    </Drawer>
  );
}
