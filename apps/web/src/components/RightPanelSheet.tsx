import { type CSSProperties, type ReactNode } from "react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import {
  RIGHT_PANEL_AGENTS_SHEET_CLASS_NAME,
  RIGHT_PANEL_AGENTS_WIDTH,
  RIGHT_PANEL_INLINE_SIDEBAR_MIN_WIDTH,
  RIGHT_PANEL_SHEET_BACKDROP_CLASS_NAME,
  RIGHT_PANEL_SHEET_CLASS_NAME,
  RIGHT_PANEL_SHEET_VIEWPORT_CLASS_NAME,
  RIGHT_PANEL_SOURCE_CONTROL_SHEET_CLASS_NAME,
} from "../rightPanelLayout";
import { Sheet, SheetPopup } from "./ui/sheet";

const SHEET_CLASS_NAME_BY_SIZE = {
  default: RIGHT_PANEL_SHEET_CLASS_NAME,
  sourceControl: RIGHT_PANEL_SOURCE_CONTROL_SHEET_CLASS_NAME,
  agents: RIGHT_PANEL_AGENTS_SHEET_CLASS_NAME,
} as const;

export function RightPanelSheet(props: {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  size?: keyof typeof SHEET_CLASS_NAME_BY_SIZE;
}) {
  const size = props.size ?? "default";

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
          SHEET_CLASS_NAME_BY_SIZE[size],
          isElectron && "pe-[var(--app-window-resize-edge-inset)]",
        )}
        style={
          {
            "--right-panel-inline-min-width": `${RIGHT_PANEL_INLINE_SIDEBAR_MIN_WIDTH}px`,
            "--right-panel-agents-width": `${RIGHT_PANEL_AGENTS_WIDTH}px`,
          } as CSSProperties
        }
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
