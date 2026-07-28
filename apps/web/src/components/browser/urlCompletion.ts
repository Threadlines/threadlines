/**
 * Finishing a URL you have typed before.
 *
 * Not history in the browser sense -- no list to browse, nothing to manage.
 * Just the part of history people actually use: type three letters of a site
 * you visit constantly and have the rest already there.
 *
 * Ranked by visits first and recency second, which is the ordering people
 * expect without being able to say so: the site you go to daily should win
 * over the one you opened once an hour ago, but among sites you visit equally
 * the recent one is the one you mean.
 */

/** One page this browser has been to. */
export interface VisitedUrl {
  readonly url: string;
  readonly visits: number;
  readonly lastVisitedAt: number;
}

/**
 * Enough to cover the handful of sites anyone actually revisits, small enough
 * that ranking it on every keystroke costs nothing worth measuring.
 */
export const MAX_VISITED_URLS = 200;

/**
 * What the user typed, reduced to the part they are aiming at.
 *
 * Nobody types the scheme, and `www.` is noise on the way to the name. Matching
 * on what remains is what lets three letters find a site.
 */
export function completionKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "");
}

function rank(a: VisitedUrl, b: VisitedUrl): number {
  return b.visits - a.visits || b.lastVisitedAt - a.lastVisitedAt;
}

/**
 * Records a visit, keeping the list capped and the counts honest.
 *
 * Returns a new list; the caller owns where it lives.
 */
export function rememberVisit(
  visited: ReadonlyArray<VisitedUrl>,
  url: string,
  now: number,
): ReadonlyArray<VisitedUrl> {
  const trimmed = url.trim();
  // A blank tab and an unparseable address are not places you have been.
  if (trimmed === "" || completionKey(trimmed) === "") {
    return visited;
  }
  const existing = visited.find((entry) => entry.url === trimmed);
  const rest = visited.filter((entry) => entry.url !== trimmed);
  const updated: VisitedUrl = {
    url: trimmed,
    visits: (existing?.visits ?? 0) + 1,
    lastVisitedAt: now,
  };
  // Dropping the lowest-ranked rather than the oldest: a site you have been to
  // fifty times should not fall off because you spent a morning elsewhere.
  return [updated, ...rest].sort(rank).slice(0, MAX_VISITED_URLS);
}

/**
 * The best completion for what has been typed so far, or null.
 *
 * Returns the whole URL, not the remainder, because the caller replaces the
 * field's value and selects the part the user did not type -- so carrying on
 * typing overwrites the guess instead of fighting it.
 */
export function completeUrl(typed: string, visited: ReadonlyArray<VisitedUrl>): string | null {
  const key = completionKey(typed);
  // One character matches half the internet and the guess would change under
  // every keystroke, which reads as the field being possessed.
  if (key.length < 2) {
    return null;
  }
  const match = [...visited]
    .sort(rank)
    .find((entry) => completionKey(entry.url).startsWith(key) && entry.url !== typed);
  if (match === undefined) {
    return null;
  }
  // Only offer it when the typed text is a genuine prefix of what we would put
  // in the field. Otherwise accepting the completion would silently rewrite
  // what is already there -- typing `facpmanuals.com/x` should not become the
  // homepage just because that is the ranked hit.
  return match.url.toLowerCase().includes(key) ? match.url : null;
}
