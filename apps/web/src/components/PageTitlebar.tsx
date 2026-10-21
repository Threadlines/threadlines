import type { ReactNode } from "react";

import { ELECTRON_HEADER_HEIGHT_CLASS } from "../desktopChrome";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { SidebarOpenTrigger, useSidebar } from "./ui/sidebar";
import { HeaderEdgeFade } from "./HeaderEdgeFade";

/**
 * The strip across the top of a full-page surface (General chats, Pull
 * requests, Usage, Settings, Fleet).
 *
 * In the desktop app at full width there is no strip by default: the window's
 * title row above the work panel already carries the sidebar toggle, back,
 * forward and the app's name, and each of these pages draws its own title. A
 * page that has controls for the whole page (Settings' Restore defaults)
 * still gets the strip, holding just those controls. In a desktop window too
 * narrow for the rail, the title row hides, so the strip comes back as the
 * row with the sidebar trigger and the page name, like a phone's.
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
  const { isMobile } = useSidebar();
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
  if (!isMobile) {
    if (!children) return null;
    return (
      <div
        className={cn(
          "drag-region relative flex shrink-0 items-center gap-2 px-5",
          ELECTRON_HEADER_HEIGHT_CLASS,
        )}
      >
        {children}
        <HeaderEdgeFade at="below" />
      </div>
    );
  }
  return (
    <div
      className={cn(
        "drag-region relative flex shrink-0 items-center gap-2 px-5",
        ELECTRON_HEADER_HEIGHT_CLASS,
      )}
    >
      <SidebarOpenTrigger className="size-7 shrink-0" />
      {label ? <span className="text-xs font-medium text-muted-foreground">{label}</span> : null}
      {children}
      <HeaderEdgeFade at="below" />
    </div>
  );
}
