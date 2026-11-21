import { create } from "zustand";

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
 * Requests to open General Chats while they are a section of Threads. The
 * command palette and the desktop menu live outside the sidebar, and the old
 * /chats address is a page of its own, so each asks here and the shell's
 * GeneralChatsRevealer does the opening: the section unfolded, the list (or a
 * phone's sheet) showing, and Threads on screen. The revealer's code loads
 * only on a device that lists the chats in Threads, so a request waits here
 * until it has.
 */
const useRevealRequests = create<{ readonly pending: number }>(() => ({ pending: 0 }));

export function requestGeneralChatsReveal(): void {
  useRevealRequests.setState((state) => ({ pending: state.pending + 1 }));
}

/** How many reveals wait to be done. */
export function usePendingGeneralChatsReveals(): number {
  return useRevealRequests((state) => state.pending);
}

/** Marks every waiting reveal done. */
export function clearPendingGeneralChatsReveals(): void {
  useRevealRequests.setState({ pending: 0 });
}

/**
 * A request that the list beside the rail stay showing across a reveal's
 * page changes. The shell hides a floating list whenever the page changes;
 * while a request stands, the change to the address it left and the one it
 * goes to show the list instead (AppSidebarLayout). `thenAny` lets one more
 * change through after that, for home on a launch, which goes on to the last
 * thread. Any other change drops it.
 */
let listReveal: {
  readonly from: string;
  readonly to: string | null;
  readonly thenAny: boolean;
} | null = null;

/** The path part of an in-app href. */
function hrefPathname(href: string): string {
  return href.split(/[?#]/u, 1)[0] || "/";
}

export function requestSidebarListReveal(
  from: string,
  toHref: string,
  options: { readonly thenAny: boolean },
): void {
  listReveal = { from: hrefPathname(from), to: hrefPathname(toHref), thenAny: options.thenAny };
}

/** Whether the page change to `pathname` should show the list rather than hide a floating one. */
export function consumeSidebarListReveal(pathname: string): boolean {
  const request = listReveal;
  if (request === null) return false;
  if (pathname === request.from) return true;
  if (request.to === null || pathname === request.to) {
    listReveal =
      request.to !== null && request.thenAny ? { from: pathname, to: null, thenAny: false } : null;
    return true;
  }
  listReveal = null;
  return false;
}
