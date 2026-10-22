import type { ReactNode } from "react";

import { ELECTRON_HEADER_HEIGHT_CLASS } from "../desktopChrome";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { SidebarOpenTrigger } from "./ui/sidebar";
import { HeaderEdgeFade } from "./HeaderEdgeFade";
import { TitleBarContent } from "./sidebar/titleBarSlot";

/**
 * The top of a full-page surface (General chats, Pull requests, Usage,
 * Settings, Fleet).
 *
 * While the window has a title row (a wide desktop window or browser), the
 * page's controls for the whole page (Settings' Restore defaults) go up into
 * the row's slot for the open page, and the page draws no strip of its own;
 * a page with no such controls leaves the slot empty. Each of these pages
 * draws its own title.
 *
 * Without a title row the strip comes back. In a desktop window too narrow
 * for the rail it is the sidebar trigger and the page name, like a phone's.
 * On the web below the `md` breakpoint the sidebar is a sheet, and the only
 * way to reach it is a trigger in the page itself, so there the strip is that
 * header: the trigger and the page name, the same row a thread shows, ending
 * in the same fade. The strip's name is then the page's one title, so a page
 * hides its own heading below `md`. Pages that already draw their own mobile
 * header (a Back arrow) opt out with `mobile="none"` rather than showing two.
 */
export function PageTitlebar({
  label,
  mobile = "sidebar",
  children,
}: {
  /** The page's name in the narrow strip. */
  readonly label?: string;
  /** What the strip is on a phone: the sidebar trigger row, or nothing. */
  readonly mobile?: "sidebar" | "none";
  /** Controls for the whole page, laid out at the end. */
  readonly children?: ReactNode;
}) {
  return (
    <TitleBarContent
      fallback={
        <NarrowPageStrip label={label} mobile={mobile}>
          {children}
        </NarrowPageStrip>
      }
    >
      {children}
    </TitleBarContent>
  );
}

function NarrowPageStrip({
  label,
  mobile,
  children,
}: {
  readonly label: string | undefined;
  readonly mobile: "sidebar" | "none";
  readonly children?: ReactNode;
}) {
  if (!isElectron) {
    if (mobile === "none") {
      return null;
    }
    return (
      <header className="relative z-10 flex shrink-0 items-center gap-2 pb-2 pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-[calc(env(safe-area-inset-top)+0.5rem)] md:hidden">
        <SidebarOpenTrigger className="size-7 shrink-0" />
        {label ? (
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{label}</span>
        ) : null}
        {children}
        <HeaderEdgeFade at="below" />
      </header>
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
