import { THEME_FILE_FORMAT, type ThemeSeedColors } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { color, formatHex, shiftLightness } from "./color.ts";
import { fitThemeColors, themeTokenSeed } from "./fit.ts";
import { THEME_TOKEN_NAMES } from "./tokenNames.ts";
import { deriveThemeTokens } from "./tokens.ts";

const seeds: ThemeSeedColors = {
  background: "#1a1b26",
  foreground: "#c0caf5",
  mutedForeground: "#9aa5ce",
  accent: "#7aa2f7",
  accentForeground: "#16161e",
  border: "#2f3549",
  success: "#9ece6a",
  warning: "#e0af68",
  danger: "#f7768e",
  info: "#7dcfff",
  codeBackground: "#16161e",
  selection: "#33467c",
};

describe("which theme color each app color comes from", () => {
  it.each(["dark", "light"] as const)("is the one that changes it (%s)", (base) => {
    const start = deriveThemeTokens(
      base === "dark"
        ? seeds
        : { ...seeds, background: "#f5f5f7", foreground: "#1f2328", mutedForeground: "#59636e" },
      base,
    );
    for (const name of THEME_TOKEN_NAMES) {
      const seed = themeTokenSeed(name, base);
      if (seed === null) continue;
      const changed = { ...seeds, [seed]: formatHex(shiftLightness(color(seeds[seed]!), 0.07)) };
      const tokens = deriveThemeTokens(
        base === "dark"
          ? changed
          : {
              ...changed,
              background: seed === "background" ? changed.background : "#f5f5f7",
              foreground: seed === "foreground" ? changed.foreground : "#1f2328",
              mutedForeground: seed === "mutedForeground" ? changed.mutedForeground : "#59636e",
            },
        base,
      );
      expect.soft(tokens[name], `${name} from ${seed}`).not.toBe(start[name]);
    }
  });
});

describe("making a theme readable", () => {
  it("moves a text color the theme sets directly, not the seed it overrides", () => {
    const fitted = fitThemeColors({
      format: THEME_FILE_FORMAT,
      name: "Paper",
      base: "light",
      colors: {
        background: "#f5f5f7",
        foreground: "#1f2328",
        mutedForeground: "#59636e",
        accent: "#0969da",
        accentForeground: "#ffffff",
      },
      overrides: { foreground: "#e8e8ea" },
    });
    if (!fitted.ok) return expect.fail(fitted.errors.join("; "));
    expect(fitted.manifest.colors.foreground).toBe("#1f2328");
    expect(fitted.manifest.overrides?.foreground).not.toBe("#e8e8ea");
  });

  it("drops a selection that can't work with the text the theme sets, rather than chase both", () => {
    const fitted = fitThemeColors({
      format: THEME_FILE_FORMAT,
      name: "Night",
      base: "dark",
      colors: {
        background: "#212121",
        foreground: "#e8e8e8",
        mutedForeground: "#a0a0a0",
        accent: "#3aa0e0",
        accentForeground: "#000000",
        selection: "#ffffff",
      },
      overrides: { foreground: "#e8e8e8" },
    });
    if (!fitted.ok) return expect.fail(fitted.errors.join("; "));
    expect(fitted.manifest.colors.selection).toBeUndefined();
    expect(fitted.manifest.overrides?.foreground).toBe("#e8e8e8");
  });

  it("moves the accent when a text-on-accent color the theme sets can't read on it and its hover", () => {
    const fitted = fitThemeColors({
      format: THEME_FILE_FORMAT,
      name: "Gray",
      base: "dark",
      colors: {
        background: "#212121",
        foreground: "#e8e8e8",
        mutedForeground: "#a0a0a0",
        accent: "#6a6a6a",
        accentForeground: "#ffffff",
      },
      overrides: { "primary-foreground": "#ffffff" },
    });
    if (!fitted.ok) return expect.fail(fitted.errors.join("; "));
    expect(fitted.manifest.colors.accent).not.toBe("#6a6a6a");
  });
});
