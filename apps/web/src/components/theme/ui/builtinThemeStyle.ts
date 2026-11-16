/**
 * The built-in theme's colors and font inside one element: what keeps the
 * trial bar and the color editor readable whatever the theme being tried does.
 */
import type { ThemeBase } from "@threadlines/contracts";
import { BUILTIN_THEME_TOKENS } from "@threadlines/shared/themeBuiltinTokens";
import { THEME_TOKEN_NAMES } from "@threadlines/shared/themeTokenNames";
import type { CSSProperties } from "react";

/** The built-in UI font, as index.css declares it. */
const BUILTIN_FONT_SANS =
  '"Schibsted Grotesk Variable", "Schibsted Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/** CSS variables that put the built-in theme back inside an element. */
export function builtinThemeStyle(base: ThemeBase): CSSProperties {
  const tokens = BUILTIN_THEME_TOKENS[base];
  const style: Record<string, string> = {
    colorScheme: base,
    fontFamily: BUILTIN_FONT_SANS,
    "--font-sans": BUILTIN_FONT_SANS,
  };
  for (const name of THEME_TOKEN_NAMES) style[`--${name}`] = tokens[name];
  return style as CSSProperties;
}
