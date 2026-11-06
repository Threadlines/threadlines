/**
 * Puts the active theme on the document (docs/design/custom-themes.md,
 * "Applying a theme"): one `<style id="tl-theme">` holding the tokens on
 * `html[data-theme]`, `data-theme-version` (the content hash), `.dark` from
 * the theme's base, the theme's fonts, and `data-glass` when it has art.
 * With a built-in theme active all of that is removed and index.css applies
 * exactly as it always has.
 */
import type { DesktopThemeAppearance } from "@threadlines/contracts";
import { themeTokensCss } from "@threadlines/shared/themeTokenNames";

import { themeFontFamily, themeFontStack } from "./themeFonts";
import type { ActiveTheme } from "./themeTypes";

export const THEME_STYLE_ID = "tl-theme";
export const GLASS_STYLE_ID = "tl-theme-glass";
/** Above `:root` and `:root.dark` in index.css, whatever order the sheets load in. */
const THEME_SELECTOR = "html:root[data-theme]";

/** The style rule for a custom theme's tokens and fonts. */
export function themeDocumentCss(theme: ActiveTheme): string {
  if (!theme.tokens) return "";
  const fonts = theme.manifest?.fonts;
  const fontCss = [
    themeFontFamily(fonts, "ui", theme.hash)
      ? `--font-sans: ${themeFontStack(fonts, "ui", theme.hash)};`
      : "",
    themeFontFamily(fonts, "mono", theme.hash)
      ? `--font-mono: ${themeFontStack(fonts, "mono", theme.hash)};`
      : "",
  ].join(" ");
  // index.html's boot styles color the body for the built-ins; a theme's text is its own.
  return `${THEME_SELECTOR}{${themeTokensCss(theme.tokens)} ${fontCss}}${THEME_SELECTOR} body{color:var(--foreground)}`;
}

function styleElement(id: string): HTMLStyleElement {
  const existing = document.getElementById(id);
  if (existing instanceof HTMLStyleElement) return existing;
  const element = document.createElement("style");
  element.id = id;
  document.head.append(element);
  return element;
}

let lastCss: string | null = null;
let lastBase: string | null = null;

/** Applies `theme` to the document. Returns whether anything visible changed. */
export function applyThemeToDocument(theme: ActiveTheme, options: { animate: boolean }): boolean {
  if (typeof document === "undefined") return false;
  const root = document.documentElement;
  const css = themeDocumentCss(theme);
  const changed = css !== lastCss || theme.base !== lastBase;
  const animate = options.animate || typeof requestAnimationFrame !== "function";
  if (changed && !animate) root.classList.add("no-transitions");
  root.classList.toggle("dark", theme.base === "dark");
  const glass = theme.manifest?.backdrop !== undefined;
  if (theme.tokens) {
    const style = styleElement(THEME_STYLE_ID);
    if (style.textContent !== css) style.textContent = css;
    root.setAttribute("data-theme", "custom");
    root.setAttribute("data-theme-version", theme.hash ?? "pending");
    root.toggleAttribute("data-glass", glass);
  } else if (root.hasAttribute?.("data-theme") || root.hasAttribute?.("data-glass")) {
    // Back to a built-in (the pre-paint script may have painted a custom
    // theme): index.css alone, as it always was.
    document.getElementById(THEME_STYLE_ID)?.remove();
    root.removeAttribute("data-theme");
    root.removeAttribute("data-theme-version");
    root.removeAttribute("data-glass");
  }
  if (!glass) document.getElementById?.(GLASS_STYLE_ID)?.remove();
  lastCss = css;
  lastBase = theme.base;
  if (changed && !animate) {
    // Force a reflow so no-transitions takes effect before it is removed.
    // oxlint-disable-next-line no-unused-expressions
    root.offsetHeight;
    requestAnimationFrame(() => root.classList.remove("no-transitions"));
  }
  return changed;
}

/** Sets the glass tints index.css's glass rules read (see glass.ts). */
export function applyGlassTints(css: string | null): void {
  if (typeof document === "undefined") return;
  if (css === null) {
    document.getElementById(GLASS_STYLE_ID)?.remove();
    return;
  }
  const rule = `html:root[data-glass]{${css}}`;
  const style = styleElement(GLASS_STYLE_ID);
  if (style.textContent !== rule) style.textContent = rule;
}

/** Loads the theme's embedded fonts; resolves true once a face is ready to measure. */
export function loadActiveThemeFonts(theme: ActiveTheme): Promise<boolean> {
  return import("./themeFontFaces").then((faces) =>
    faces.loadThemeFonts(theme.manifest?.fonts, theme.hash),
  );
}

const opaqueHex = (value: string) => (/^#[0-9a-fA-F]{8}$/.test(value) ? value.slice(0, 7) : value);

/**
 * What the desktop window is told: the native preference apart from colors.
 * Built-in System stays `system` so the OS keeps driving it; a custom theme
 * sets its base and the window's own colors.
 */
export function desktopThemeAppearance(theme: ActiveTheme): DesktopThemeAppearance {
  if (!theme.tokens) {
    // A built-in, or a custom theme whose content is nowhere (its base shows).
    const choice = theme.choice;
    return { nativeSource: choice.kind === "builtin" ? choice.id : theme.base };
  }
  return {
    nativeSource: theme.base,
    colors: {
      windowBackground: opaqueHex(theme.tokens["surface-solid"]),
      titleBarSymbol: opaqueHex(theme.tokens.foreground),
    },
  };
}
