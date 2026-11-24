/**
 * The `#place=` hash a page opens with to highlight a place
 * (docs/design/app-guide.md, "Place links in the chat"). Apart from
 * appPlaceLinks.ts, which reads the place catalog, so ways into a place that
 * load at startup (the project menu's brief link) don't load the catalog.
 */
import type { PlaceId } from "@threadlines/shared/appPlaces";

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
