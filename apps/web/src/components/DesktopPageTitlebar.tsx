import type { ReactNode } from "react";

import { ELECTRON_HEADER_HEIGHT_CLASS } from "../desktopChrome";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { SidebarOpenTrigger } from "./ui/sidebar";

/**
 * The desktop window's titlebar strip for full-page surfaces.
 *
 * On desktop the window controls overlay the top of the content area, so every
 * page needs a draggable strip of titlebar height above its scroll container --
 * otherwise the page's scrollbar runs underneath the minimize/close buttons and
 * there is nothing to grab to move the window. Renders nothing outside the
 * desktop app.
 */
export function DesktopPageTitlebar({
  label,
  children,
}: {
  /** Small muted page name, matching the other pages' strips. */
  readonly label?: string;
  /** Optional extra content, laid out after the label. */
  readonly children?: ReactNode;
}) {
  if (!isElectron) {
    return null;
  }
  return (
    <div
      className={cn(
        "drag-region flex shrink-0 items-center gap-2 border-b border-border px-5 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
        ELECTRON_HEADER_HEIGHT_CLASS,
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
    >
      <SidebarOpenTrigger className="size-7 shrink-0" />
      {label ? (
        <span className="text-xs font-medium tracking-wide text-muted-foreground/70">{label}</span>
      ) : null}
      {children}
    </div>
  );
}
