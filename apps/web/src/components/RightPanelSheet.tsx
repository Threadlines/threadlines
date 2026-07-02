import { type CSSProperties, type ReactNode } from "react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import {
  RIGHT_PANEL_INLINE_SIDEBAR_MIN_WIDTH,
  RIGHT_PANEL_SHEET_CLASS_NAME,
  RIGHT_PANEL_SOURCE_CONTROL_SHEET_BACKDROP_CLASS_NAME,
  RIGHT_PANEL_SOURCE_CONTROL_SHEET_CLASS_NAME,
  RIGHT_PANEL_SOURCE_CONTROL_SHEET_VIEWPORT_CLASS_NAME,
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
      // The source control sheet starts below the chat header so the header's
      // toggle keeps working while it is open. That needs a non-modal dialog
      // (the header must stay interactive) with pointer dismissal disabled: an
      // outside-press dismissal on the toggle would close the sheet before the
      // toggle's click reopens it. The backdrop closes it explicitly instead.
      modal={!sourceControl}
      disablePointerDismissal={sourceControl}
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
        viewportClassName={
          sourceControl ? RIGHT_PANEL_SOURCE_CONTROL_SHEET_VIEWPORT_CLASS_NAME : undefined
        }
        backdropProps={
          sourceControl
            ? {
                className: RIGHT_PANEL_SOURCE_CONTROL_SHEET_BACKDROP_CLASS_NAME,
                onClick: props.onClose,
              }
            : undefined
        }
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
