/**
 * Code colors (docs/design/custom-themes.md, "Code"). Every theme's code
 * colors are a Shiki theme registered once with Pierre's resolver, which the
 * highlight worker and the diff renderer both resolve through; their caches
 * key on the theme name. A custom theme's is `tl-custom-<hash>`: its code
 * palette over the base's Pierre theme, which supplies every color the
 * palette leaves out. The built-ins' are `tl-code-light` and `tl-code-dark`.
 * Either way each color is fitted to read on every background code is drawn
 * on (shared themes/codeColors.ts), the diff tints included. The fitting and
 * the built-in tokens load with the first theme resolved, not at startup.
 * The editor's selected text and cursor line take their backgrounds from
 * the theme too (withEditorColors), so those are set to match the fit.
 */
import { type DiffsTheme, registerCustomTheme, resolveThemes } from "@pierre/diffs";
import type { ThemeBase, ThemeCodePalette } from "@threadlines/contracts";
import type { Rgba } from "@threadlines/shared/themeColor";
import type { ThemeTokens } from "@threadlines/shared/themeTokens";
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

/**
 * The theme with every color fitted to read on `surfaces`: each rule's at the
 * ratio its scopes need (comments and punctuation quieter), the text at the
 * full one. Colors that already read are left exactly as they are.
 */
export function fitCodeTheme(
  theme: TextMateTheme,
  surfaces: ReadonlyArray<Rgba>,
  fit: {
    readonly color: (value: string, surfaces: ReadonlyArray<Rgba>, ratio: number) => string;
    readonly ratioFor: (scopes: ReadonlyArray<string>) => number;
    readonly textRatio: number;
  },
): TextMateTheme {
  const rules = (theme.settings ?? theme.tokenColors ?? []).map((rule) => {
    const foreground = rule.settings?.foreground;
    if (!foreground) return rule;
    const fitted = fit.color(foreground, surfaces, fit.ratioFor(scopesOf(rule)));
    return fitted === foreground
      ? rule
      : { ...rule, settings: { ...rule.settings, foreground: fitted } };
  });
  const fg = theme.fg ? fit.color(theme.fg, surfaces, fit.textRatio) : theme.fg;
  const { tokenColors: _tokenColors, ...rest } = theme;
  return {
    ...rest,
    fg,
    settings: rules,
    colors: { ...theme.colors, ...(fg ? { "editor.foreground": fg } : {}) },
  };
}

/**
 * The editor's backgrounds, which it takes from the code theme: selected
 * text gets `selection` (a surface the colors are fitted against), and the
 * line with the cursor gets no fill of its own (the editor outlines it
 * instead), so its code sits on the plain background.
 */
export function withEditorColors(theme: TextMateTheme, selection: string): TextMateTheme {
  const { "editor.lineHighlightBackground": _lineHighlight, ...colors } = theme.colors ?? {};
  return { ...theme, colors: { ...colors, "editor.selectionBackground": selection } };
}

export function customCodeThemeName(hash: string): DiffThemeName {
  return `tl-custom-${hash}`;
}

const builtinCodeThemeName = (base: ThemeBase): DiffThemeName => `tl-code-${base}`;

const registered = new Set<string>();

/**
 * Registers a code theme under its name, once (Pierre refuses a second
 * registration): the base's Pierre theme, with `palette` over it when the
 * theme has one, fitted to the backgrounds of `tokens` (a built-in's when
 * null).
 */
function ensureRegistered(
  name: DiffThemeName,
  themeBase: ThemeBase,
  palette: ThemeCodePalette | null,
  tokens: ThemeTokens | null,
): void {
  if (registered.has(name)) return;
  registered.add(name);
  registerCustomTheme(
    name,
    async () => {
      const [[baseTheme], codeColors, builtinTokens] = await Promise.all([
        resolveThemes([resolveDiffThemeName(themeBase)], "shiki-js"),
        import("@threadlines/shared/themeCodeColors"),
        tokens ? null : import("@threadlines/shared/themeBuiltinTokens"),
      ]);
      if (!baseTheme?.textmate) throw new Error(`No base theme for ${name}`);
      const withPalette = palette
        ? buildCodeTheme(name, palette, baseTheme.textmate)
        : { ...baseTheme.textmate, name };
      const surfaceTokens = tokens ?? builtinTokens?.BUILTIN_THEME_TOKENS[themeBase];
      if (!surfaceTokens) throw new Error(`No tokens for ${name}`);
      const surfaces = codeColors.codeSurfaces(surfaceTokens);
      const fitted = fitCodeTheme(withPalette, surfaces, {
        color: codeColors.fitCodeColor,
        ratioFor: codeColors.codeRatioForScopes,
        textRatio: codeColors.CODE_TEXT_RATIO,
      });
      return withEditorColors(fitted, codeColors.editorSelectionHex(surfaceTokens));
    },
    "textmate",
  );
}

/** The code theme a theme highlights with, registered and ready to resolve. */
export function codeThemeNameFor(theme: ActiveTheme): DiffThemeName {
  // A custom theme once its content is here (its palette and tokens settle the name's colors).
  if (theme.tokens && theme.hash && theme.manifest) {
    const palette = theme.manifest.code;
    const name = customCodeThemeName(theme.hash);
    ensureRegistered(
      name,
      theme.base,
      palette && Object.values(palette).some(Boolean) ? palette : null,
      theme.tokens,
    );
    return name;
  }
  const name = builtinCodeThemeName(theme.base);
  ensureRegistered(name, theme.base, null, null);
  return name;
}

/** The active theme's code theme name, for highlighting and diffs. */
export function useCodeThemeName(): DiffThemeName {
  const active = useActiveTheme();
  return useMemo(() => codeThemeNameFor(active), [active]);
}
