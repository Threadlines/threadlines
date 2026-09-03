import type { ReactNode } from "react";

import { ELECTRON_HEADER_HEIGHT_CLASS } from "../desktopChrome";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { SidebarOpenTrigger } from "./ui/sidebar";

/**
 * The strip across the top of a full-page surface (General chats, Pull
 * requests, Usage, Settings).
 *
 * On desktop the window controls overlay the top of the content area, so every
 * page needs a draggable strip of titlebar height above its scroll container --
 * otherwise the page's scrollbar runs underneath the minimize/close buttons and
 * there is nothing to grab to move the window.
 *
 * On the web below the `md` breakpoint the sidebar is a sheet, and the only
 * way to reach it is a trigger in the page itself. A thread carries one in its
 * header; a page with none strands the reader. So here the strip is that
 * header: the trigger and the page name, the same row a thread shows. Pages
 * that already draw their own mobile header (a Back arrow) opt out with
 * `mobile="none"` rather than showing two.
 */
export function PageTitlebar({
  label,
  mobile = "sidebar",
  children,
}: {
  /** Small muted page name on desktop; the header title on a phone. */
  readonly label?: string;
  /** What the strip is on a phone: the sidebar trigger row, or nothing. */
  readonly mobile?: "sidebar" | "none";
  /** Optional extra content, laid out after the label. */
  readonly children?: ReactNode;
}) {
  if (!isElectron) {
    if (mobile === "none") {
      return null;
    }
    return (
      <header className="flex shrink-0 items-center gap-2 border-b border-border pb-2 pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-[calc(env(safe-area-inset-top)+0.5rem)] md:hidden">
        <SidebarOpenTrigger className="size-7 shrink-0" />
        {label ? (
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{label}</span>
        ) : null}
        {children}
      </header>
    );
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
