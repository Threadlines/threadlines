/**
 * Whether this app load has already had its launch moment: the one navigation
 * that lands the user in their work (route restore, the default-project draft,
 * or the server's bootstrap welcome payload).
 *
 * The index route consults this to tell a launch apart from a deliberate trip
 * home ("Go to Home", the settings back button): the launch visit redirects,
 * everything after renders the home surface. It lives outside the index route
 * because the launch does not necessarily pass through `/` at all -- the
 * bootstrap welcome payload and a desktop deep link both land directly on a
 * thread route -- and being on any thread means the launch already happened.
 *
 * @module launchVisit
 */

let consumed = false;

export function isLaunchVisitConsumed(): boolean {
  return consumed;
}

export function markLaunchVisitConsumed(): void {
  consumed = true;
}
