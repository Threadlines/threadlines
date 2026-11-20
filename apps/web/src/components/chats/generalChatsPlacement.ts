import { useSettings } from "../../hooks/useSettings";

/**
 * Whether this device lists General Chats in a section at the foot of the
 * Threads list instead of on their own page (Settings › Threads › General
 * chats). The rail, the inbox and the /chats route all read it, so switching
 * moves everything at once and switching back undoes it.
 */
export function useGeneralChatsInThreads(): boolean {
  return useSettings((settings) => settings.generalChatsPlacement === "threads");
}

/**
 * A request, from the old General Chats address, that the list beside the
 * rail show across the redirect to Threads. The shell hides a floating list
 * whenever the page changes; while a request stands, the change to the
 * address it came from and the one it goes to show the list instead
 * (AppSidebarLayout). Any other change drops it.
 */
let listReveal: { readonly from: string; readonly to: string } | null = null;

/** The path part of an in-app href. */
function hrefPathname(href: string): string {
  return href.split(/[?#]/u, 1)[0] || "/";
}

export function requestSidebarListReveal(from: string, toHref: string): void {
  listReveal = { from: hrefPathname(from), to: hrefPathname(toHref) };
}

/**
 * Whether the page change to `pathname` should show the list rather than
 * hide a floating one. Reaching the redirect's target, or anywhere else,
 * ends the request.
 */
export function consumeSidebarListReveal(pathname: string): boolean {
  if (listReveal === null) return false;
  if (pathname === listReveal.from) return true;
  const revealed = pathname === listReveal.to;
  listReveal = null;
  return revealed;
}
