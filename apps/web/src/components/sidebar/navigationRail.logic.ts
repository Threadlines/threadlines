/**
 * The app's destinations, as the rail (wide screens) and the phone sheet's
 * row of icons both offer them. Pure: which one a route selects.
 */

export type NavigationDestinationId =
  | "threads"
  | "chats"
  | "pull-requests"
  | "fleet"
  | "usage"
  | "settings";

/** Top to bottom in the rail, left to right on a phone. Settings sits apart, at the end. */
export const NAVIGATION_DESTINATION_ORDER: readonly NavigationDestinationId[] = [
  "threads",
  "chats",
  "pull-requests",
  "fleet",
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
  if (isUnder(pathname, "/usage")) return "usage";
  return input.openThreadIsGeneralChat ? "chats" : "threads";
}
