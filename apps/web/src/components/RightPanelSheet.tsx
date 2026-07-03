import { type CSSProperties, type ReactNode } from "react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import {
  RIGHT_PANEL_INLINE_SIDEBAR_MIN_WIDTH,
  RIGHT_PANEL_SHEET_BACKDROP_CLASS_NAME,
  RIGHT_PANEL_SHEET_CLASS_NAME,
  RIGHT_PANEL_SHEET_VIEWPORT_CLASS_NAME,
  RIGHT_PANEL_SOURCE_CONTROL_SHEET_CLASS_NAME,
} from "../rightPanelLayout";
import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  size?: "default" | "sourceControl";
}) {
  const size = props.size ?? "default";
  const sourceControl = size === "sourceControl";

  return (
    <Sheet
      open={props.open}
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
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        viewportClassName={RIGHT_PANEL_SHEET_VIEWPORT_CLASS_NAME}
        backdropProps={{
          className: RIGHT_PANEL_SHEET_BACKDROP_CLASS_NAME,
          onClick: props.onClose,
        }}
        className={cn(
          sourceControl
            ? RIGHT_PANEL_SOURCE_CONTROL_SHEET_CLASS_NAME
            : RIGHT_PANEL_SHEET_CLASS_NAME,
          isElectron && "pe-[var(--app-window-resize-edge-inset)]",
        )}
        style={
          {
            "--right-panel-inline-min-width": `${RIGHT_PANEL_INLINE_SIDEBAR_MIN_WIDTH}px`,
          } as CSSProperties
        }
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
