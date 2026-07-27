/**
 * Playwright's element engine, running inside the guest page.
 *
 * The vendored script is a CommonJS module exporting one class. This is the
 * small amount of glue that turns it into something we can call: a wrapper that
 * gives it a module to export into, constructs it with the options it wants,
 * and parks it somewhere our later calls can find.
 *
 * It goes into an **isolated world**, not the page's own. Two reasons, and the
 * second is the one that matters. An isolated world shares the DOM but not the
 * JavaScript context, so nothing we add is reachable by the page: a page cannot
 * read our handle, replace `querySelector` underneath us, or notice it is being
 * automated by looking for our globals. The competitor we studied assigns to
 * `globalThis.__t3PlaywrightInjected` in the main world, which is all three of
 * those problems at once.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The vendored script, read once.
 *
 * From disk rather than bundled in, because 311KB of someone else's generated
 * code in the main bundle is 311KB parsed at every start for a feature most
 * sessions never touch.
 */
let cachedSource: string | null = null;

export function injectedScriptSource(): string {
  cachedSource ??= readFileSync(
    join(import.meta.dirname, "vendor", "playwrightInjected.js"),
    "utf8",
  );
  return cachedSource;
}

/** The isolated world the engine runs in, named so Chrome hands back the same
 *  one rather than making another on every call. */
export const INJECTED_WORLD_NAME = "threadlines-preview";

/** Where the constructed engine lives inside the isolated world. */
export const INJECTED_HANDLE = "__threadlinesInjected";

/**
 * Builds the engine, or returns the one already built.
 *
 * Idempotent because an isolated world outlives a single call but not a
 * navigation, and the caller should not have to track which of those just
 * happened.
 */
export function buildInjectedRuntimeScript(source = injectedScriptSource()): string {
  return `
(() => {
  if (globalThis.${INJECTED_HANDLE}) {
    return true;
  }
  const module = { exports: {} };
  ${source}
  // The class binding, not module.exports. esbuild assigns the exports object
  // at the top of the bundle, before the class exists, and its spread captures
  // an undefined that never updates -- so module.exports.InjectedScript is
  // permanently not a constructor.
  globalThis.${INJECTED_HANDLE} = new InjectedScript(globalThis, {
    isUnderTest: false,
    sdkLanguage: "javascript",
    testIdAttributeName: "data-testid",
    stableRafCount: 1,
    browserName: "chromium",
    customEngines: [],
  });
  return true;
})();
`;
}

/**
 * Resolves a Playwright locator to a single element.
 *
 * Returns the element itself, so the caller can turn it into a node id the rest
 * of our automation already speaks. A locator that matches nothing, or matches
 * several things, is an error rather than a guess -- picking the first of four
 * "Delete" buttons is exactly the kind of helpfulness nobody wants from a tool
 * that clicks things.
 */
export function buildLocatorQueryScript(locator: string): string {
  return `
(() => {
  const injected = globalThis.${INJECTED_HANDLE};
  if (!injected) {
    throw new Error("the element engine is not loaded in this frame");
  }
  const parsed = injected.parseSelector(${JSON.stringify(locator)});
  const matches = injected.querySelectorAll(parsed, document);
  if (matches.length === 0) {
    throw new Error(
      "no element matches " + ${JSON.stringify(JSON.stringify(locator))} +
      "; take a new snapshot or loosen the locator",
    );
  }
  if (matches.length > 1) {
    throw new Error(
      matches.length + " elements match " + ${JSON.stringify(JSON.stringify(locator))} +
      "; narrow it, for example with nth= or by naming an enclosing region",
    );
  }
  return matches[0];
})();
`;
}

/**
 * The page as an accessibility tree, with a ref on everything.
 *
 * This is what replaces our own tree walk. Ours kept only actionable and
 * landmark nodes that had an accessible name, which meant an agent could see
 * every button and not a word of what the page said. This carries the text too,
 * and the refs in it are what the other tools take.
 */
export function buildAriaSnapshotScript(): string {
  return `
(() => {
  const injected = globalThis.${INJECTED_HANDLE};
  if (!injected) {
    throw new Error("the element engine is not loaded in this frame");
  }
  return injected.ariaSnapshot(document.body, { mode: "ai", refPrefix: "" });
})();
`;
}
