/**
 * A page's top bar while the thread list is hidden on a wide screen: its
 * content starts clear of the window controls that reach past the rail (the
 * macOS traffic lights). Phones draw the list as a sheet, so it never applies
 * there.
 */
export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "md:[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)]";
