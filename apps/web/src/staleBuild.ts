/**
 * Recovery for a page that outlived its build.
 *
 * A build names its code files by content hash, and a deploy (the hosted app)
 * or an update (a computer's own server) replaces the whole set. A page still
 * running the old build asks for a file that is gone the first time it needs a
 * part it hasn't loaded yet, and that import fails. Phones make this common: a
 * tab the system put to sleep comes back from its cached page, on the old
 * build.
 *
 * Retrying the import cannot help (browsers remember a failed module), but a
 * reload fetches the current page and its files. The root error screen asks
 * {@link resolveStaleBuildRecovery} what to do: reload on its own, wait until
 * the app can be reached again, or leave the reload to the user.
 */

/** How browsers and Vite word an import whose file is gone or isn't code. */
const STALE_BUILD_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  // Chromium.
  /^Failed to fetch dynamically imported module/,
  // Firefox.
  /^error loading dynamically imported module/,
  // WebKit (Safari, and every browser on iOS) when the file is missing...
  /^Importing a module script failed/,
  // ...and when a host answers for the missing file with its app page.
  /is not a valid JavaScript MIME type/,
  // Vite, when a lazy part's stylesheet is gone.
  /^Unable to preload CSS for /,
];

const RELOADS_KEY = "threadlines:stale-build-reloads";

/** How long the reachability check waits before calling the app unreachable. */
const REACHABILITY_TIMEOUT_MS = 8_000;

/** How often an unreachable app is checked again: longer than one check takes. */
export const STALE_BUILD_RECHECK_MS = REACHABILITY_TIMEOUT_MS + 2_000;

export function isStaleBuildError(error: unknown): boolean {
  const message =
    typeof error === "object" && error !== null && "message" in error ? error.message : null;
  return (
    typeof message === "string" &&
    STALE_BUILD_ERROR_PATTERNS.some((pattern) => pattern.test(message))
  );
}

export type StaleBuildRecovery =
  /** Reload now: the app answered, and this reload hasn't been tried. */
  | "reload"
  /** The app didn't answer; a reload now would land on the browser's error page. */
  | "unreachable"
  /** The same reload already ran in this tab and the page failed again. */
  | "leave-to-user";

/** Set once this page load claims its reload, so asking again agrees. */
let reloadClaimed = false;

/**
 * What a page that hit a stale-build failure should do. It fetches the app's
 * page fresh every time it is asked: that proves a reload would load (the
 * browser's own online flag can't, either way), and names the build a reload
 * would bring.
 *
 * Each move from this page's build to the server's runs at most once per tab,
 * recorded before it is allowed. A deploy is a move to a new build, so it
 * always gets its reload; a failure the reload didn't fix asks for the same
 * move again and is left to the user. A run of moves would need a new build
 * every time, so a reload loop is impossible without any timing guess.
 * Asking again in the same page load agrees with a yes already given, once
 * the app answers again.
 */
export async function resolveStaleBuildRecovery(): Promise<StaleBuildRecovery> {
  const serverBuild = await fetchServerBuild();
  if (serverBuild === undefined) {
    return "unreachable";
  }
  if (reloadClaimed) {
    return "reload";
  }
  const move = `${pageBuild(document) ?? ""} -> ${serverBuild ?? ""}`;
  try {
    const raw = window.sessionStorage.getItem(RELOADS_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    const moves = Array.isArray(parsed) ? parsed : [];
    if (moves.includes(move)) {
      return "leave-to-user";
    }
    window.sessionStorage.setItem(RELOADS_KEY, JSON.stringify([...moves, move]));
  } catch {
    // Without the record nothing stops a loop.
    return "leave-to-user";
  }
  reloadClaimed = true;
  return "reload";
}

/**
 * The build a page runs, named by its entry script (the address a build
 * hashes). Null when the page names none.
 */
function pageBuild(page: Document): string | null {
  const src = page.querySelector('script[type="module"][src]')?.getAttribute("src");
  return src ? new URL(src, window.location.origin).href : null;
}

/** The build the server's page names now; undefined when it can't be reached. */
async function fetchServerBuild(): Promise<string | null | undefined> {
  try {
    const response = await fetch(new URL("/", window.location.origin), {
      cache: "no-store",
      credentials: "same-origin",
      signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
    });
    if (!response.ok) {
      return undefined;
    }
    return pageBuild(new DOMParser().parseFromString(await response.text(), "text/html"));
  } catch {
    return undefined;
  }
}
