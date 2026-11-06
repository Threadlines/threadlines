/**
 * A theme's font family as CSS (docs/design/custom-themes.md, "Fonts"). A
 * `system` font may name several families, like a CSS stack
 * (`ui-monospace, "SF Mono", Menlo, monospace`); each name is kept to safe
 * characters and quoted, and generic families stay bare. The app and the
 * preview both write it this way, so an agent sees the font the user gets.
 */

/** CSS generic families: written bare, never quoted. */
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "cursive",
  "fantasy",
  "math",
  "emoji",
  "fangsong",
]);

/** A name that can't end the quotes or the rule it sits in. */
const SAFE_NAME = /^[\p{L}\p{N} ._-]{1,80}$/u;

/** The family list as CSS, or null when no usable name is left. */
export function cssFontFamilyList(family: string): string | null {
  const names = family
    .split(",")
    .map((name) => name.replace(/["']/g, "").trim())
    .filter((name) => SAFE_NAME.test(name))
    .map((name) => (GENERIC_FAMILIES.has(name) ? name : `"${name}"`));
  return names.length > 0 ? names.join(", ") : null;
}
