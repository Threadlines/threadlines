/**
 * The search engines the browser panel's address bar can use: the Settings
 * row's choices, and where a search for some words goes.
 */
import type { BrowserSearchEngine } from "@threadlines/contracts";

/** "Browser search engine", as its menu words each choice. */
export const BROWSER_SEARCH_ENGINE_LABELS: Readonly<Record<BrowserSearchEngine, string>> = {
  google: "Google",
  duckduckgo: "DuckDuckGo",
  bing: "Bing",
  brave: "Brave Search",
  kagi: "Kagi",
};

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
