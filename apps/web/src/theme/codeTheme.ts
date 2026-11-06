/**
 * Code colors under a custom theme (docs/design/custom-themes.md, "Code"). A
 * theme's code palette becomes a Shiki theme named `tl-custom-<hash>`,
 * registered once with Pierre's resolver, which the highlight worker and the
 * diff renderer both resolve through; their caches key on the theme name.
 * The base's Pierre theme supplies every color the palette leaves out, and
 * is what shows when a theme has no palette.
 */
import { type DiffsTheme, registerCustomTheme, resolveThemes } from "@pierre/diffs";
import type { ThemeBase, ThemeCodePalette } from "@threadlines/contracts";
import { useMemo } from "react";

import { type DiffThemeName, resolveDiffThemeName } from "../lib/diffRendering";
import { useActiveTheme } from "./themeStore";
import type { ActiveTheme } from "./themeTypes";

type TextMateTheme = NonNullable<DiffsTheme["textmate"]>;
type TextMateRule = TextMateTheme["settings"][number];

/** The TextMate scopes each palette color paints. */
const PALETTE_SCOPES: Readonly<Record<Exclude<keyof ThemeCodePalette, "foreground">, string[]>> = {
  comment: ["comment", "punctuation.definition.comment"],
  keyword: ["keyword", "storage", "keyword.control"],
  string: ["string", "punctuation.definition.string"],
  number: ["constant.numeric", "constant.language", "constant.character"],
  function: ["entity.name.function", "support.function"],
  type: ["entity.name.type", "entity.name.class", "support.type", "support.class"],
  variable: ["variable", "meta.definition.variable"],
  operator: ["keyword.operator"],
  punctuation: ["punctuation", "meta.brace"],
};

const scopesOf = (rule: TextMateRule): string[] =>
  rule.scope === undefined ? [] : Array.isArray(rule.scope) ? rule.scope : [rule.scope];

/**
 * The base theme with the palette's colors: the base's rules for a category
 * the palette sets are dropped (a more specific base rule would otherwise
 * win), then one rule per category is added.
 */
export function buildCodeTheme(
  name: string,
  palette: ThemeCodePalette,
  base: TextMateTheme,
): TextMateTheme {
  const replaced = Object.entries(PALETTE_SCOPES).flatMap(([category, scopes]) =>
    palette[category as keyof typeof PALETTE_SCOPES] ? scopes : [],
  );
  // keyword.operator belongs to the operator color, not the keyword one.
  const isReplaced = (scope: string) =>
    replaced.some((prefix) => scope === prefix || scope.startsWith(`${prefix}.`)) &&
    !(scope.startsWith("keyword.operator") && !palette.operator && palette.keyword);
  const kept = (base.settings ?? base.tokenColors ?? []).filter((rule) => {
    const scopes = scopesOf(rule);
    return scopes.length === 0 || !scopes.some(isReplaced);
  });
  const added: TextMateRule[] = Object.entries(PALETTE_SCOPES).flatMap(([category, scope]) => {
    const color = palette[category as keyof typeof PALETTE_SCOPES];
    return color ? [{ scope, settings: { foreground: color } }] : [];
  });
  const fg = palette.foreground ?? base.fg;
  const { tokenColors: _tokenColors, ...rest } = base;
  return {
    ...rest,
    name,
    fg,
    settings: [...kept, ...added],
    colors: { ...base.colors, "editor.foreground": fg },
  };
}

export function customCodeThemeName(hash: string): DiffThemeName {
  return `tl-custom-${hash}`;
}

const registered = new Set<string>();

/** Registers a theme's code palette under its name, once (Pierre refuses a second registration). */
function ensureRegistered(name: string, palette: ThemeCodePalette, themeBase: ThemeBase): void {
  if (registered.has(name)) return;
  registered.add(name);
  registerCustomTheme(
    name,
    async () => {
      const [baseTheme] = await resolveThemes([resolveDiffThemeName(themeBase)], "shiki-js");
      if (!baseTheme?.textmate) throw new Error(`No base theme for ${name}`);
      return buildCodeTheme(name, palette, baseTheme.textmate);
    },
    "textmate",
  );
}

/** The code theme a theme highlights with, registered and ready to resolve. */
export function codeThemeNameFor(theme: ActiveTheme): DiffThemeName {
  const palette = theme.manifest?.code;
  if (theme.tokens && theme.hash && palette && Object.values(palette).some(Boolean)) {
    const name = customCodeThemeName(theme.hash);
    ensureRegistered(name, palette, theme.base);
    return name;
  }
  return resolveDiffThemeName(theme.base);
}

/** The active theme's code theme name, for highlighting and diffs. */
export function useCodeThemeName(): DiffThemeName {
  const active = useActiveTheme();
  return useMemo(() => codeThemeNameFor(active), [active]);
}
