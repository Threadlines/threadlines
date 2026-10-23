import type { ComponentType } from "react";

import { lazyWithPreload } from "../../lib/lazyWithPreload";
import { SettingsDestinationList } from "../settings/SettingsSidebarNav";
import type { NavigationDestinationId } from "./navigationRail.logic";

// The pages' own lists are chunks of their own: a launch shows the threads,
// so startup never waits for them, and the shell fetches them once it has
// painted (preloadDestinationLists) so the first switch is instant.
const GeneralChatsList = lazyWithPreload(() =>
  import("../chats/GeneralChatsList").then((module) => module.GeneralChatsList),
);
const FleetComputersList = lazyWithPreload(() =>
  import("../fleet/FleetComputersList").then((module) => module.FleetComputersList),
);
const ScheduledTasksList = lazyWithPreload(() =>
  import("../scheduled/ScheduledTasksList").then((module) => module.ScheduledTasksList),
);

/** Fetches every page's list ahead of its first showing. */
export function preloadDestinationLists(): void {
  void GeneralChatsList.preload();
  void FleetComputersList.preload();
  void ScheduledTasksList.preload();
}

/** What the list beside the rail shows while a destination is on screen. */
export interface DestinationList {
  /** The thread inbox, or a page's own list (rendered under a Suspense boundary). */
  readonly body: "inbox" | ComponentType;
  /** It ends in a footer of its own; otherwise the shared one (update notices, version) does. */
  readonly ownFooter?: boolean;
  /**
   * A phone's sheet shows this list instead of the threads while the page is
   * open: the page's own way between its items (chats, computers, tasks).
   * Settings leaves it out: on a phone its page is already its list.
   */
  readonly inPhoneSheet?: boolean;
}

/**
 * Each destination's list, or null where the page has none and takes the
 * work panel's full width (the sidebar toggle is then disabled). Giving a
 * destination a list is one entry here.
 */
export const DESTINATION_LISTS: Record<NavigationDestinationId, DestinationList | null> = {
  threads: { body: "inbox" },
  chats: { body: GeneralChatsList.Component, inPhoneSheet: true },
  "pull-requests": null,
  fleet: { body: FleetComputersList.Component, inPhoneSheet: true },
  scheduled: { body: ScheduledTasksList.Component, inPhoneSheet: true },
  usage: null,
  settings: { body: SettingsDestinationList, ownFooter: true },
};

export function destinationHasList(id: NavigationDestinationId): boolean {
  return DESTINATION_LISTS[id] !== null;
}

/**
 * The list beside the rail while `selected` is on screen: the destination's
 * own on a wide screen, the threads in a phone's sheet unless the page's list
 * belongs there. Null where the page has none.
 */
export function resolveShownDestinationList(
  selected: NavigationDestinationId,
  isMobile: boolean,
): DestinationList | null {
  return isMobile && DESTINATION_LISTS[selected]?.inPhoneSheet !== true
    ? DESTINATION_LISTS.threads
    : DESTINATION_LISTS[selected];
}
