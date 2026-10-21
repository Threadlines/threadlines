import type { ComponentType } from "react";

import { GeneralChatsList } from "../chats/GeneralChatsList";
import { FleetComputersList } from "../fleet/FleetComputersList";
import { SettingsDestinationList } from "../settings/SettingsSidebarNav";
import type { NavigationDestinationId } from "./navigationRail.logic";

/** What the list beside the rail shows while a destination is on screen. */
export interface DestinationList {
  /** The thread inbox, or a page's own list. */
  readonly body: "inbox" | ComponentType;
  /** It ends in a footer of its own; otherwise the shared one (update notices, version) does. */
  readonly ownFooter?: boolean;
}

/**
 * Each destination's list, or null where the page has none and takes the
 * work panel's full width (the sidebar toggle is then disabled). Giving a
 * destination a list is one entry here.
 */
export const DESTINATION_LISTS: Record<NavigationDestinationId, DestinationList | null> = {
  threads: { body: "inbox" },
  chats: { body: GeneralChatsList },
  "pull-requests": null,
  fleet: { body: FleetComputersList },
  usage: null,
  settings: { body: SettingsDestinationList, ownFooter: true },
};

export function destinationHasList(id: NavigationDestinationId): boolean {
  return DESTINATION_LISTS[id] !== null;
}
