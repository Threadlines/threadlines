import { FindMyWay } from "effect/http";

/**
 * A check of which routes a request URL reaches, read the way the server's
 * router reads it (its defaults: any case, duplicate and trailing slashes
 * ignored, escapes decoded, a query after `?`, `;` or `#`), so a rule on a
 * path holds however the path is spelled. Patterns are router patterns
 * (`/api/hooks/*`); the match is the key given with the pattern.
 */
export const makeRoutePatternMatcher = <K>(
  patterns: ReadonlyArray<readonly [pattern: string, key: K]>,
): ((url: string) => K | undefined) => {
  const router = FindMyWay.make<K>();
  for (const [pattern, key] of patterns) {
    router.on("GET", pattern as FindMyWay.PathInput, key);
  }
  return (url) => {
    let target = url;
    // An absolute-form request URL: the router reads its path.
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(target)) {
      try {
        const parsed = new URL(target);
        target = `${parsed.pathname}${parsed.search}`;
      } catch {
        // Not a URL after all: read it as a path.
      }
    }
    return router.find("GET", target)?.handler;
  };
};
