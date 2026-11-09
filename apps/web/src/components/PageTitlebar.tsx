import type { ReactNode } from "react";

import { ELECTRON_HEADER_HEIGHT_CLASS } from "../desktopChrome";
import { cn } from "../lib/utils";
import { SidebarOpenTrigger } from "./ui/sidebar";
import { HeaderEdgeFade } from "./HeaderEdgeFade";
import {
  TitleBarContent,
  useTitleBarHeaderRef,
  useTitleBarRowPresent,
} from "./sidebar/titleBarSlot";
import { glassPage } from "../theme/glassPage";

/**
 * The top of a full-page surface (General chats, Pull requests, Usage,
 * Settings, Fleet).
 *
 * While the window has a title row (the desktop layout), the page's controls
 * for the whole page (Settings' Restore defaults) go up into the row's slot
 * for the open page, and the page draws no strip of its own; a page with no
 * such controls leaves the slot empty. Each of these pages draws its own
 * title. In a window too narrow for the controls up there, they get a strip
 * of their own under the title row instead.
 *
 * Without a title row (the phone layout: the web below the `md` breakpoint)
 * the sidebar is a sheet, and the only way to reach it is a trigger in the
 * page itself, so there the strip is that header: the trigger and the page
 * name, the same row a thread shows, ending in the same fade. The strip's
 * name is then the page's one title, so a page hides its own heading in the
 * phone layout. Pages that already draw their own phone header (a Back arrow)
 * opt out with `mobile="none"` rather than showing two.
 */
export function PageTitlebar({
  label,
  mobile = "sidebar",
  children,
}: {
  /** The page's name in the phone's strip. */
  readonly label?: string;
  /** What the strip is on a phone: the sidebar trigger row, or nothing. */
  readonly mobile?: "sidebar" | "none";
  /** Controls for the whole page, laid out at the end. */
  readonly children?: ReactNode;
}) {
  const controls =
    children === null || children === undefined || children === false ? null : (
      <PageTitlebarControls>{children}</PageTitlebarControls>
    );
  return (
    <TitleBarContent
      fallback={
        <NarrowPageStrip label={label} mobile={mobile}>
          {controls}
        </NarrowPageStrip>
      }
    >
      {controls}
    </TitleBarContent>
  );
}

/** The page's controls at the end of whichever row holds them; the title row measures them. */
function PageTitlebarControls({ children }: { readonly children: ReactNode }) {
  const titleBarHeaderRef = useTitleBarHeaderRef();
  return (
    <div ref={titleBarHeaderRef} className="ms-auto flex shrink-0 items-center gap-2">
      {children}
    </div>
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
  const titleRowPresent = useTitleBarRowPresent();
  if (titleRowPresent) {
    // The title row is there but too narrow for the controls: just them, at
    // the end of a row of their own. The page below draws its own title.
    return (
      <div
        {...glassPage.header}
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
  if (mobile === "none") {
    return null;
  }
  return (
    <header
      {...glassPage.header}
      className="relative z-10 flex shrink-0 items-center gap-2 pb-2 pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-[calc(env(safe-area-inset-top)+0.5rem)] desktop:hidden"
    >
      <SidebarOpenTrigger className="size-7 shrink-0" />
      {label ? (
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{label}</span>
      ) : null}
      {children}
      <HeaderEdgeFade at="below" />
    </header>
  );
}
