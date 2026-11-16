/**
 * The custom order's Move up and Move down for a thread, as the sidebar
 * decides them, for menus opened elsewhere (the thread's title in the chat
 * header). The order is the sidebar's: what is a row's neighbour, and moving
 * it, need the inbox as the sidebar lays it out, so the sidebar provides its
 * own function here instead of anyone working it out a second time. Nothing
 * provided (no sidebar mounted): no such items.
 *
 * @module inboxCustomOrderMenu
 */
import type { ThreadMenuTarget } from "../../hooks/useThreadMenu";

export type InboxCustomOrderMenu = NonNullable<ThreadMenuTarget["customOrder"]>;

type CustomOrderMenuOf = (threadKey: string) => InboxCustomOrderMenu | null;

let provided: CustomOrderMenuOf | null = null;

/** The sidebar offers its custom order's items; the returned function takes them back. */
export function provideInboxCustomOrderMenu(menuOf: CustomOrderMenuOf): () => void {
  provided = menuOf;
  return () => {
    if (provided === menuOf) provided = null;
  };
}

/** Move up and Move down for a thread (by scoped key) as its sidebar row offers them, or null. */
export function readInboxCustomOrderMenu(threadKey: string): InboxCustomOrderMenu | null {
  return provided?.(threadKey) ?? null;
}
