/**
 * Where the browser panel's address bar sends a search. The engines' names
 * are with the Settings choices (BROWSER_SEARCH_ENGINE_LABELS in appPlaces.ts);
 * this is apart from them so only the browser panel loads it.
 */
import type { BrowserSearchEngine } from "@threadlines/contracts";

const SEARCH_PAGES: Readonly<Record<BrowserSearchEngine, string>> = {
  google: "https://www.google.com/search",
  duckduckgo: "https://duckduckgo.com/",
  bing: "https://www.bing.com/search",
  brave: "https://search.brave.com/search",
  kagi: "https://kagi.com/search",
};

/** The results page for `query` on a search engine. */
export function browserSearchUrl(engine: BrowserSearchEngine, query: string): string {
  const url = new URL(SEARCH_PAGES[engine]);
  url.searchParams.set("q", query);
  return url.toString();
}
