/**
 * The app's destinations, as the rail (wide screens) and the phone sheet's
 * row of icons both offer them. Pure: which one a route selects.
 */

export type NavigationDestinationId =
  | "threads"
  | "chats"
  | "pull-requests"
  | "fleet"
  | "scheduled"
  | "usage"
  | "settings";

/** Each destination's name, as its button's tooltip and accessible name say it. */
export const NAVIGATION_DESTINATION_LABELS: Record<NavigationDestinationId, string> = {
  threads: "Threads",
  chats: "General Chats",
  "pull-requests": "Pull Requests",
  fleet: "Fleet",
  scheduled: "Scheduled",
  usage: "Usage",
  settings: "Settings",
};

/**
 * Each destination's name under its icon on a phone, which can't hover for
 * the tooltip: short enough for all seven to share the sheet's row.
 */
export const NAVIGATION_DESTINATION_SHORT_LABELS: Record<NavigationDestinationId, string> = {
  threads: "Threads",
  chats: "Chats",
  "pull-requests": "PRs",
  fleet: "Fleet",
  scheduled: "Scheduled",
  usage: "Usage",
  settings: "Settings",
};

/** Top to bottom in the rail, left to right on a phone. Settings sits apart, at the end. */
export const NAVIGATION_DESTINATION_ORDER: readonly NavigationDestinationId[] = [
  "threads",
  "chats",
  "pull-requests",
  "fleet",
  "scheduled",
  "usage",
  "settings",
];

function isUnder(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * The destination the rail shows selected: Threads for home, a thread or a
 * draft. A general chat open in the main view selects General Chats instead:
 * it lives there, not in the inbox.
 */
export function resolveSelectedDestination(input: {
  readonly pathname: string;
  readonly openThreadIsGeneralChat: boolean;
}): NavigationDestinationId {
  const { pathname } = input;
  if (isUnder(pathname, "/settings")) return "settings";
  if (isUnder(pathname, "/chats")) return "chats";
  if (isUnder(pathname, "/pull-requests")) return "pull-requests";
  if (isUnder(pathname, "/fleet")) return "fleet";
  if (isUnder(pathname, "/scheduled")) return "scheduled";
  if (isUnder(pathname, "/usage")) return "usage";
  return input.openThreadIsGeneralChat ? "chats" : "threads";
}
