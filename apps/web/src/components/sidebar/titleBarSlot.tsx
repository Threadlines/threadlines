import { createContext, type ReactNode, type RefCallback, use } from "react";
import { createPortal } from "react-dom";

/**
 * The open page's part of the window's title row (AppTitleBar), or null while
 * there is no title row: a window too narrow for the rail, or a phone.
 */
export const TitleBarSlotContext = createContext<HTMLElement | null>(null);

/**
 * A page's header. While the window has a title row it goes up into the
 * row's slot for the open page, after the toggle, back, forward and the app's
 * name, the way Mail, Notes and Finder put their toolbars in the title bar.
 * Without one it is `fallback`, the page's own header row, unchanged (with
 * the sidebar trigger a narrow window and a phone need).
 *
 * In the row the content fills the slot (`h-full`), so `measureRef` reads
 * the row's bottom as the header's; empty space around the controls still
 * moves the window, and the controls themselves never do.
 */
export function TitleBarContent({
  children,
  fallback = null,
  measureRef,
  findRegion,
}: {
  readonly children?: ReactNode;
  readonly fallback?: ReactNode;
  readonly measureRef?: RefCallback<HTMLElement>;
  /** Marks the header as part of a find-in-page region, as the inline header is. */
  readonly findRegion?: string;
}) {
  const slot = use(TitleBarSlotContext);
  if (slot === null) return fallback;
  if (children === null || children === undefined || children === false) return null;
  return createPortal(
    <div
      ref={measureRef}
      data-find-region={findRegion}
      data-testid="titlebar-page-content"
      className="flex h-full min-w-0 flex-1 items-center gap-2"
    >
      {children}
    </div>,
    slot,
  );
}
