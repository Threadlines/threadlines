import { type CSSProperties, type ReactNode } from "react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import {
  RIGHT_PANEL_INLINE_SIDEBAR_MIN_WIDTH,
  RIGHT_PANEL_SHEET_CLASS_NAME,
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

  return (
    <Sheet
      open={props.open}
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
        className={cn(
          size === "sourceControl"
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
