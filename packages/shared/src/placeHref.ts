/**
 * The scheme of a place link (`threadlines-place:<id>`), apart from the place
 * catalog in appPlaces.ts, so code that only needs to recognize a place link
 * (the chat's markdown, at startup) doesn't load every place.
 */
export const PLACE_HREF_SCHEME = "threadlines-place:";

/** Whether an href is a place link at all, known to this build or not. */
export const isPlaceLinkHref = (href: string): boolean => href.startsWith(PLACE_HREF_SCHEME);
