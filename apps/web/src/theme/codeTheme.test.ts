import { resolveThemes } from "@pierre/diffs";
import { BUILTIN_THEME_TOKENS } from "@threadlines/shared/themeBuiltinTokens";
import {
  CODE_TEXT_RATIO,
  codeRatioForScopes,
  codeSurfaces,
  fitCodeColor,
} from "@threadlines/shared/themeCodeColors";
import { color, composite, contrastRatio } from "@threadlines/shared/themeColor";
import { STARTER_THEMES } from "@threadlines/shared/themeStarters";
import { resolveThemeTokens } from "@threadlines/shared/themeTokens";
import { describe, expect, it } from "vite-plus/test";

import { resolveDiffThemeName } from "../lib/diffRendering";
import { buildCodeTheme, fitCodeTheme } from "./codeTheme";

const FIT = { color: fitCodeColor, ratioFor: codeRatioForScopes, textRatio: CODE_TEXT_RATIO };
const scopesOf = (scope: string | string[] | undefined) =>
  scope === undefined ? [] : Array.isArray(scope) ? scope : [scope];

/** Every rule color, with the ratio it needs, that reads below it on some surface. */
function unreadable(
  theme: Awaited<ReturnType<typeof resolveThemes>>[number]["textmate"],
  surfaces: ReturnType<typeof codeSurfaces>,
) {
  const rules = theme?.settings ?? theme?.tokenColors ?? [];
  return rules.flatMap((rule) => {
    const value = rule.settings?.foreground;
    if (!value) return [];
    const ratio = codeRatioForScopes(scopesOf(rule.scope));
    return surfaces.some(
      (surface) => contrastRatio(composite(color(value), surface), surface) < ratio - 0.01,
    )
      ? [`${String(rule.scope)} ${value}`]
      : [];
  });
}

describe("code colors", () => {
  it("fits the built-in code colors to read on every line of a diff, leaving the ones that read", async () => {
    for (const base of ["light", "dark"] as const) {
      const [pierre] = await resolveThemes([resolveDiffThemeName(base)], "shiki-js");
      const surfaces = codeSurfaces(BUILTIN_THEME_TOKENS[base]);
      // The shipped colors don't, today: strings and numbers on light, operators on dark.
      expect(unreadable(pierre!.textmate, surfaces).length).toBeGreaterThan(0);
      const fitted = fitCodeTheme(pierre!.textmate!, surfaces, FIT);
      expect(unreadable(fitted, surfaces)).toEqual([]);
    }
    const surfaces = codeSurfaces(BUILTIN_THEME_TOKENS.light);
    expect(fitCodeColor("#0a0a0a", surfaces, CODE_TEXT_RATIO)).toBe("#0a0a0a");
  });

  it("never leaves a color reading worse than it did, where no color reads everywhere", () => {
    // A mid-gray code background in a dark theme: light text can't read on both.
    const surfaces = [color("#777777"), color("#0a1029")];
    const worst = (value: string) =>
      Math.min(
        ...surfaces.map((surface) => contrastRatio(composite(color(value), surface), surface)),
      );
    const fitted = fitCodeColor("#fafafa", surfaces, CODE_TEXT_RATIO);
    expect(worst(fitted)).toBeGreaterThanOrEqual(worst("#fafafa"));
  });

  it("fits a theme's own palette the same way, hue kept", async () => {
    const meadow = STARTER_THEMES.find((starter) => starter.id === "meadow")!.manifest;
    const [pierre] = await resolveThemes([resolveDiffThemeName(meadow.base)], "shiki-js");
    const surfaces = codeSurfaces(resolveThemeTokens(meadow));
    const fitted = fitCodeTheme(
      buildCodeTheme("meadow", meadow.code!, pierre!.textmate!),
      surfaces,
      FIT,
    );
    expect(unreadable(fitted, surfaces)).toEqual([]);
    // Its strings, a little short on a changed word, stay green: darker, not another color.
    const string = fitCodeColor(meadow.code!.string!, surfaces, CODE_TEXT_RATIO);
    expect(string).not.toBe(meadow.code!.string);
    const [before, after] = [color(meadow.code!.string!), color(string)];
    expect(after.g).toBeGreaterThan(after.r);
    expect(after.g).toBeLessThanOrEqual(before.g);
  });
});
