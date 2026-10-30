/**
 * Place links in the chat (docs/design/app-guide.md, "Place links in the chat"):
 * what a `threadlines-place:<id>` link does when clicked, and the `#place=`
 * hash that tells the page it opens which place to highlight. Pure, so the
 * chip (components/chat/PlaceLink.tsx) and the arrival hook
 * (hooks/usePlaceArrival.ts) read the same answers.
 */
import type { EnvironmentId } from "@threadlines/contracts";
import {
  isPlaceId,
  PLACE_HREF_SCHEME,
  type PlaceId,
  placeChain,
  placeIdFromHref,
  placePage,
  placeRoute,
} from "@threadlines/shared/appPlaces";

/**
 * What a place link does:
 * - `open`: go to `href` (an in-app path with the search that reveals the place);
 * - `elsewhere`: the place is a setting of the computer the thread runs on, which
 *   this app does not show, so the chip only names it;
 * - `desktopOnly`: only the desktop app has the place, and this isn't it.
 */
export type PlaceLinkTarget =
  | { readonly kind: "open"; readonly placeId: PlaceId; readonly href: string }
  | {
      readonly kind: "elsewhere";
      readonly placeId: PlaceId;
      readonly environmentId: EnvironmentId;
    }
  | { readonly kind: "desktopOnly"; readonly placeId: PlaceId };

/** Whether an href is a place link at all, known to this build or not. */
export const isPlaceLinkHref = (href: string): boolean => href.startsWith(PLACE_HREF_SCHEME);

/** Where a place's value lives: its own scope, else the nearest holder's, else the computer. */
export function placeScope(placeId: PlaceId) {
  for (const place of placeChain(placeId).toReversed()) {
    if (place.scope !== undefined) return place.scope;
  }
  return "computer";
}

function routeHref(to: string, search: Readonly<Record<string, string>> | undefined): string {
  const query = search === undefined ? "" : new URLSearchParams(search).toString();
  return query.length > 0 ? `${to}?${query}` : to;
}

/**
 * What a place link in a thread's reply does. `null` when the href is not a
 * place this build knows (an old message naming a place since renamed), which
 * the chat shows as plain words.
 *
 * Compares environments, never machines: a thread on another environment is on
 * another computer as far as this app's screens are concerned.
 */
export function resolvePlaceLink(input: {
  readonly href: string;
  /** The environment the thread runs on; null when the reply is not in a thread. */
  readonly threadEnvironmentId: EnvironmentId | null;
  /** The app's own environment; null before it is known. */
  readonly primaryEnvironmentId: EnvironmentId | null;
  /** This is the desktop app, which has places a browser or phone doesn't. */
  readonly isDesktopApp: boolean;
  /** The project folder the reply's thread belongs to, when known. */
  readonly threadProjectRoot?: string | null | undefined;
}): PlaceLinkTarget | null {
  const placeId = placeIdFromHref(input.href);
  if (placeId === null) return null;
  if (!input.isDesktopApp && placeChain(placeId).some((place) => place.appliesWhen === "desktop")) {
    return { kind: "desktopOnly", placeId };
  }
  const page = placePage(placeId);
  const open = (href: string): PlaceLinkTarget => ({ kind: "open", placeId, href });

  // Fleet shows every computer: its sections open the thread's computer's page.
  if (page.target === "fleet") {
    const environmentId = input.threadEnvironmentId ?? input.primaryEnvironmentId;
    return page.id === placeId || environmentId === null
      ? open("/fleet")
      : open(`/fleet/${encodeURIComponent(environmentId)}`);
  }

  const route = placeRoute(placeId);
  const here = open(routeHref(route.to, route.search));
  // Pages that pick their own computer and project (Plugins & Skills, Agent
  // Instructions) open on the thread's: `environment` and `project` in the
  // search, which those pages apply on arrival.
  if (page.target === "thread") {
    const environmentId = input.threadEnvironmentId ?? input.primaryEnvironmentId;
    return open(
      routeHref(route.to, {
        ...route.search,
        ...(environmentId !== null ? { environment: environmentId } : {}),
        ...(input.threadProjectRoot ? { project: input.threadProjectRoot } : {}),
      }),
    );
  }
  // This device's and the desktop app's settings are here.
  if (placeScope(placeId) !== "computer") return here;
  // Left-bar pages (Scheduled, Usage, Pull Requests) already span computers.
  if (!route.to.startsWith("/settings/")) return here;
  const { threadEnvironmentId, primaryEnvironmentId } = input;
  return threadEnvironmentId !== null &&
    primaryEnvironmentId !== null &&
    threadEnvironmentId !== primaryEnvironmentId
    ? { kind: "elsewhere", placeId, environmentId: threadEnvironmentId }
    : here;
}

/**
 * The hash a place link opens its page with. `click` changes on every click, so
 * clicking the same link again highlights the place again.
 */
export const placeArrivalHash = (placeId: PlaceId, click: number): string =>
  new URLSearchParams({ place: placeId, n: String(click) }).toString();

let placeArrivals = 0;

/**
 * The hash for opening a place now: each opening gets its own number, so
 * opening the same place again (a chip, a settings search result) highlights
 * it again.
 */
export function nextPlaceArrivalHash(placeId: PlaceId): string {
  placeArrivals += 1;
  return placeArrivalHash(placeId, placeArrivals);
}

/** The place a route hash (without its `#`) asks to highlight, or null. */
export function placeIdFromArrivalHash(hash: string): PlaceId | null {
  if (!hash.startsWith("place=")) return null;
  const placeId = new URLSearchParams(hash).get("place");
  return placeId !== null && isPlaceId(placeId) ? placeId : null;
}

/**
 * The computer and project a place link asks Plugins & Skills or Agent
 * Instructions to show (`?environment=&project=`, from resolvePlaceLink), or
 * null. Those pages apply it once per arrival, so a later pick of their own
 * stands.
 */
export function placeScopeFromSearch(
  search: Record<string, unknown>,
): { readonly environmentId: string; readonly project: string | null } | null {
  const environmentId = search["environment"];
  if (typeof environmentId !== "string" || environmentId.length === 0) return null;
  const project = search["project"];
  return {
    environmentId,
    project: typeof project === "string" && project.length > 0 ? project : null,
  };
}

/** The search params a page keeps for placeScopeFromSearch. */
export function placeScopeSearch(search: Record<string, unknown>): {
  readonly environment?: string;
  readonly project?: string;
} {
  const scope = placeScopeFromSearch(search);
  return scope === null
    ? {}
    : {
        environment: scope.environmentId,
        ...(scope.project !== null ? { project: scope.project } : {}),
      };
}
