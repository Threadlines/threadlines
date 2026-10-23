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

import {
  VENDOR_DIRECTORY_NAME,
  VENDORED_INJECTED_SCRIPT_FILENAME,
} from "@threadlines/shared/previewInjectedScript";

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
    join(import.meta.dirname, VENDOR_DIRECTORY_NAME, VENDORED_INJECTED_SCRIPT_FILENAME),
    "utf8",
  );
  return cachedSource;
}

/** The isolated world the engine runs in, named so Chrome hands back the same
 *  one rather than making another on every call. */
export const INJECTED_WORLD_NAME = "threadlines-preview";

/** Where the constructed engine lives inside the isolated world. */
export const INJECTED_HANDLE = "__threadlinesInjected";
/** The frame number the engine there was built with; see `buildInjectedRuntimeScript`. */
const INJECTED_FRAME_SEQ = "__threadlinesInjectedFrameSeq";

/** Whether the world already holds an engine built with this frame number. */
export function injectedRuntimeReadyExpression(frameSeq = 0): string {
  return `Boolean(globalThis.${INJECTED_HANDLE}) && globalThis.${INJECTED_FRAME_SEQ} === ${frameSeq}`;
}

/**
 * Builds the engine, or returns the one already built.
 *
 * Idempotent because an isolated world outlives a single call but not a
 * navigation, and the caller should not have to track which of those just
 * happened. `frameSeq` is the number a frame's snapshot refs carry (`2` makes
 * `f2e7`); the page's top document has none (0).
 */
export function buildInjectedRuntimeScript(source = injectedScriptSource(), frameSeq = 0): string {
  return `
(() => {
  // One built with another number is replaced: its refs would name the
  // wrong frame.
  if (globalThis.${INJECTED_HANDLE} && globalThis.${INJECTED_FRAME_SEQ} === ${frameSeq}) {
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
    frameSeq: ${frameSeq},
  });
  globalThis.${INJECTED_FRAME_SEQ} = ${frameSeq};
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

/** A target that names an element rather than pointing at it or referring to a snapshot. */
export type NamedTarget =
  | { readonly selector: string }
  | { readonly locator: string }
  | { readonly text: string };

/**
 * The element a CSS selector, a Playwright locator or visible text names in
 * one frame's document, or null when it names none there. A target that is
 * wrong rather than absent throws: an invalid selector, or a locator that
 * matches several elements. Run in the engine's world in each frame in turn
 * (see PreviewAutomation `findNamed`).
 */
export function buildFindScript(target: NamedTarget): string {
  if ("selector" in target) {
    return `
(() => {
  try {
    return document.querySelector(${JSON.stringify(target.selector)});
  } catch {
    throw new Error(
      "no element matches selector " + ${JSON.stringify(JSON.stringify(target.selector))} +
      "; use a valid selector or take a new snapshot",
    );
  }
})();
`;
  }
  if ("locator" in target) {
    return `
(() => {
  const injected = globalThis.${INJECTED_HANDLE};
  if (!injected) {
    throw new Error("the element engine is not loaded in this frame");
  }
  const parsed = injected.parseSelector(${JSON.stringify(target.locator)});
  const matches = injected.querySelectorAll(parsed, document);
  if (matches.length > 1) {
    throw new Error(
      matches.length + " elements match " + ${JSON.stringify(JSON.stringify(target.locator))} +
      "; narrow it, for example with nth= or by naming an enclosing region",
    );
  }
  return matches[0] ?? null;
})();
`;
  }
  // The shortest visible element whose text is exactly what was asked for,
  // then one that contains it; something clickable before what wraps it.
  return `
(() => {
  const wanted = ${JSON.stringify(target.text)};
  const clickableSelector = 'button, a, [role="button"], input, summary';
  const depth = (element) => {
    let value = 0;
    for (let current = element; current.parentElement; current = current.parentElement) {
      value += 1;
    }
    return value;
  };
  const visible = (element) => {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const candidates = [...document.querySelectorAll('*')]
    .filter(visible)
    .map((element) => ({ element, text: (element.innerText || '').trim() }))
    .filter((candidate) => candidate.text !== '');
  const rank = (left, right) => {
    const clickable =
      Number(right.element.matches(clickableSelector)) -
      Number(left.element.matches(clickableSelector));
    return clickable !== 0 ? clickable : depth(left.element) - depth(right.element);
  };
  const exact = candidates.filter((candidate) => candidate.text === wanted).sort(rank);
  if (exact.length > 0) {
    return exact[0].element;
  }
  const containing = candidates.filter((candidate) => candidate.text.includes(wanted)).sort(rank);
  return containing.length > 0 ? containing[0].element : null;
})();
`;
}

/**
 * The frame elements in one frame's document that are on show, in document
 * order, open shadow roots included. A frame that is hidden or fully
 * transparent is left out: what it holds is not what an agent naming
 * something means, and a click on it would land on whatever is underneath.
 */
export const VISIBLE_FRAME_OWNERS_SCRIPT = `
(() => {
  const owners = [];
  const visible = (element) => {
    if (
      typeof element.checkVisibility === "function" &&
      !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    ) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const walk = (root) => {
    for (const element of root.querySelectorAll("*")) {
      if ((element.localName === "iframe" || element.localName === "frame") && visible(element)) {
        owners.push(element);
      }
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(document);
  return owners;
})();
`;

/**
 * A frame's document as an accessibility tree, with a ref on everything.
 *
 * This is what replaces our own tree walk. Ours kept only actionable and
 * landmark nodes that had an accessible name, which meant an agent could see
 * every button and not a word of what the page said. This carries the text too,
 * and the refs in it are what the other tools take. The engine numbers a
 * frame's refs itself, by the `frameSeq` it was built with.
 */
export function buildAriaSnapshotScript(): string {
  return `
(() => {
  const injected = globalThis.${INJECTED_HANDLE};
  if (!injected) {
    throw new Error("the element engine is not loaded in this frame");
  }
  if (!document.body) return "";
  return injected.ariaSnapshot(document.body, { mode: "ai" });
})();
`;
}
