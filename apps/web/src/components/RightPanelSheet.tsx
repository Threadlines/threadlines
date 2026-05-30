import { type ReactNode } from "react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { RIGHT_PANEL_SHEET_CLASS_NAME } from "../rightPanelLayout";
import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
}) {
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
          RIGHT_PANEL_SHEET_CLASS_NAME,
          isElectron && "pe-[var(--app-window-resize-edge-inset)]",
        )}
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
