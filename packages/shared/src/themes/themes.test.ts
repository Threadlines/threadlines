import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { THEME_FILE_FORMAT, type ThemeEntry, type ThemeManifest } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  color,
  colorBox,
  contrastRatio,
  formatHex,
  minimumGlassTint,
  rgbToOklch,
} from "./color.ts";
import { glassTextColors, measureThemeContrast } from "./contrast.ts";
import { cssFontFamilyList } from "./fontFamilies.ts";
import { themeGlassLevel } from "./glassLevel.ts";
import { reconcileThemeLibraries, winningThemeEntry } from "./library.ts";
import { checkThemeManifest, themeContentHash } from "./manifest.ts";
import { BUILTIN_THEME_TOKENS } from "./builtinTokens.ts";
import { deriveThemeTokens, THEME_TOKEN_NAMES } from "./tokens.ts";

const aurora: ThemeManifest = {
  format: THEME_FILE_FORMAT,
  name: "Aurora",
  base: "dark",
  colors: {
    background: "#0a1029",
    foreground: "#e7ecff",
    mutedForeground: "#a3aed2",
    accent: "#2fd6b0",
    accentForeground: "#03231c",
  },
};

const dunes: ThemeManifest = {
  format: THEME_FILE_FORMAT,
  name: "Dunes",
  base: "light",
  colors: {
    background: "#fbf6ee",
    foreground: "#2a1f16",
    mutedForeground: "#6f5b48",
    accent: "#b8532a",
    accentForeground: "#fff7ef",
  },
};

/**
 * The simple `--name: value;` declarations of index.css's light block and its
 * nested dark block, with `var()` and Tailwind's `--alpha()` resolved.
 */
function indexCssTokens(): Record<"light" | "dark", Record<string, string>> {
  const css = readFileSync(
    fileURLToPath(new URL("../../../../apps/web/src/index.css", import.meta.url)),
    "utf8",
  );
  const start = css.indexOf("--background: oklch(0.98 0 0);");
  const darkStart = css.indexOf("@variant dark {", start);
  const darkEnd = css.indexOf("\n  }\n", darkStart);
  const read = (block: string) =>
    Object.fromEntries(
      [...block.matchAll(/^\s*--([a-z0-9-]+):\s*([^;]+);/gm)].map((match) => [
        match[1]!,
        match[2]!.trim(),
      ]),
    );
  const light = read(css.slice(css.lastIndexOf(":root {", start), darkStart));
  const dark = { ...light, ...read(css.slice(darkStart, darkEnd)) };
  const palette: Record<string, string> = {
    "color-white": "#ffffff",
    "color-black": "#000000",
    "color-red-400": "oklch(70.4% 0.191 22.216)",
    "color-red-500": "oklch(63.7% 0.237 25.331)",
    "color-red-700": "oklch(50.5% 0.213 27.518)",
    "color-emerald-400": "oklch(76.5% 0.177 163.223)",
    "color-emerald-500": "oklch(69.6% 0.17 162.48)",
    "color-emerald-700": "oklch(50.8% 0.118 165.612)",
    "color-amber-400": "oklch(82.8% 0.189 84.429)",
    "color-amber-500": "oklch(76.9% 0.188 70.08)",
    "color-amber-700": "oklch(55.5% 0.163 48.998)",
  };
  const resolve = (set: Record<string, string>, value: string): string => {
    const alpha = /^--alpha\(var\(--([a-z0-9-]+)\)\s*\/\s*([\d.]+)%\)$/.exec(value);
    if (alpha) {
      const base = color(resolve(set, `var(--${alpha[1]})`));
      return formatHex({ ...base, a: Number(alpha[2]) / 100 });
    }
    const variable = /^var\(--([a-z0-9-]+)\)$/.exec(value);
    if (variable) return resolve(set, palette[variable[1]!] ?? set[variable[1]!]!);
    if (value.startsWith("color-mix")) return value;
    return formatHex(color(value));
  };
  const resolveTokens = (set: Record<string, string>) =>
    Object.fromEntries(
      THEME_TOKEN_NAMES.filter((name) => set[name] !== undefined).map((name) => [
        name,
        resolve(set, set[name]!),
      ]),
    );
  return { light: resolveTokens(light), dark: resolveTokens(dark) };
}

describe("theme tokens", () => {
  it("keeps the built-in token table in step with index.css", () => {
    const css = indexCssTokens();
    for (const base of ["light", "dark"] as const) {
      for (const name of THEME_TOKEN_NAMES) {
        const declared = css[base][name];
        // New with themes, or composed with color-mix: not declared as a plain value.
        if (declared === undefined || declared.startsWith("color-mix")) continue;
        expect([base, name, formatHex(color(BUILTIN_THEME_TOKENS[base][name]))]).toEqual([
          base,
          name,
          declared,
        ]);
      }
    }
  });

  it("steps surfaces the way the built-in ladder does", () => {
    const lightness = (manifest: ThemeManifest, name: (typeof THEME_TOKEN_NAMES)[number]) =>
      rgbToOklch(color(deriveThemeTokens(manifest.colors, manifest.base)[name])).l;
    const dark = ["app-chrome-background", "background", "rail", "card", "popover"] as const;
    const darkSteps = dark.map((name) => lightness(aurora, name));
    expect(darkSteps).toEqual(darkSteps.toSorted((first, second) => first - second));
    expect(lightness(dunes, "app-chrome-background")).toBeLessThan(lightness(dunes, "rail"));
    expect(lightness(dunes, "rail")).toBeLessThan(lightness(dunes, "background"));
    expect(lightness(dunes, "background")).toBeLessThanOrEqual(lightness(dunes, "card"));
  });
});

describe("readability check", () => {
  it("passes the built-in themes and themes derived from seeds", () => {
    for (const base of ["light", "dark"] as const) {
      const failing = measureThemeContrast(BUILTIN_THEME_TOKENS[base], base).filter(
        (result) => !result.passes,
      );
      expect(failing.map((result) => result.pair.id)).toEqual([]);
    }
    expect(checkThemeManifest(aurora)).toMatchObject({ ok: true });
    expect(checkThemeManifest(dunes)).toMatchObject({ ok: true });
    // A soft palette whose half-strength ink would leave focus rings under 3:1.
    expect(
      checkThemeManifest({
        ...dunes,
        colors: {
          background: "#eef2f3",
          foreground: "#1d2a30",
          mutedForeground: "#56656c",
          accent: "#2d6a8a",
          accentForeground: "#ffffff",
        },
      }),
    ).toMatchObject({ ok: true });
  });

  it("refuses a theme whose popover text is its fill, and unknown overrides", () => {
    const check = checkThemeManifest({
      ...aurora,
      overrides: { "popover-foreground": "#1c243f", popover: "#1c243f", "not-a-token": "#ffffff" },
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.contrast.map((failure) => failure.id)).toContain("foreground/popover");
    expect(check.errors.some((error) => error.includes('"not-a-token"'))).toBe(true);
  });

  it("refuses see-through surfaces and text, and unreadable code and terminal colors", () => {
    const check = checkThemeManifest({
      ...aurora,
      overrides: { background: "#ffffff00", border: "#ffffff22" },
      code: { keyword: "#0b1230", comment: "#5c6a90" },
      terminal: [
        "#000000",
        "#0c1230",
        "#5af78e",
        "#f3f99d",
        "#57c7ff",
        "#ff6ac1",
        "#9aedfe",
        "#f1f1f0",
        "#686868",
        "#ff5c57",
        "#5af78e",
        "#f3f99d",
        "#57c7ff",
        "#ff6ac1",
        "#9aedfe",
        "#ffffff",
      ],
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(
      check.errors.some((error) => error.includes('"background" must be an opaque color')),
    ).toBe(true);
    expect(check.errors.some((error) => error.includes('"border"'))).toBe(false);
    expect(check.contrast.map((failure) => failure.id)).toEqual(
      expect.arrayContaining(["code/keyword", "terminal/1"]),
    );
    expect(check.contrast.map((failure) => failure.id)).not.toContain("terminal/0");
  });

  it("raises a glass tint until text reads over any pixel in the art's color box", () => {
    const tint = color("#0a1029");
    const texts = [{ color: color("#e7ecff"), ratio: 4.5 }];
    // Thin white lines on black art: the box spans the whole range.
    const wide = minimumGlassTint({
      tint,
      box: colorBox([color("#000000"), color("#ffffff")]),
      texts,
      floor: 0.3,
    });
    const brightest = {
      r: wide * tint.r + (1 - wide),
      g: wide * tint.g + (1 - wide),
      b: wide * tint.b + (1 - wide),
      a: 1,
    };
    expect(contrastRatio(color("#e7ecff"), brightest)).toBeGreaterThanOrEqual(4.5);
    expect(wide).toBeGreaterThan(0.5);
    // Dark art already reads: the floor stands.
    const narrow = minimumGlassTint({
      tint,
      box: colorBox([color("#000000"), color("#101830")]),
      texts,
      floor: 0.3,
    });
    expect(narrow).toBe(0.3);
  });
});

describe("text over the art", () => {
  it("keeps 4.5:1, or 3:1 for an art-first theme", () => {
    const tokens = BUILTIN_THEME_TOKENS.dark;
    expect(new Set(glassTextColors(tokens).map((text) => text.ratio))).toEqual(new Set([4.5]));
    expect(new Set(glassTextColors(tokens, "relaxed").map((text) => text.ratio))).toEqual(
      new Set([3]),
    );
  });
});

describe("the Glass level", () => {
  it("is the user's own, else their old Art in threads choice, else the theme's own", () => {
    expect(themeGlassLevel({ themeGlass: 80, themeArtInThreads: "none" })).toBe(80);
    expect(
      (["none", "some", "full"] as const).map((choice) =>
        themeGlassLevel({ themeArtInThreads: choice }),
      ),
    ).toEqual([0, 50, 75]);
    expect(themeGlassLevel({})).toBe(50);
  });
});

describe("theme fonts", () => {
  it("writes a system font's family list as CSS: names quoted, generics bare, unsafe names dropped", () => {
    expect(cssFontFamilyList('ui-monospace, "SF Mono", Menlo, monospace')).toBe(
      'ui-monospace, "SF Mono", "Menlo", monospace',
    );
    expect(cssFontFamilyList('Evil"; } body { color: red')).toBeNull();
  });
});

describe("theme content hash", () => {
  it("names content: not the name or prompt, but every byte of fonts and still", async () => {
    const hash = await themeContentHash(aurora);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await themeContentHash({ ...aurora, name: "Northern lights", prompt: "a winter night" }),
    ).toBe(hash);
    const withArt: ThemeManifest = {
      ...aurora,
      fonts: { mono: { family: "Geist Mono", source: "google", data: "AAAA" } },
      glass: { frame: 0.4, list: 0.5, column: 0.4, composer: 0.7, blur: 22 },
      backdrop: { mode: "grid", script: "x", maxFps: 15, still: "data:image/png;base64,AAAA" },
    };
    const otherStill = {
      ...withArt,
      backdrop: { ...withArt.backdrop!, still: "data:image/png;base64,BBBB" },
    };
    expect(await themeContentHash(otherStill)).not.toBe(await themeContentHash(withArt));
    expect(
      await themeContentHash({ ...aurora, colors: { ...aurora.colors, accent: "#2fd6b1" } }),
    ).not.toBe(hash);
  });
});

describe("theme library reconciliation", () => {
  const entry = (patch: Partial<ThemeEntry>): ThemeEntry => ({
    entryId: "e1",
    name: "Aurora",
    hash: "a".repeat(64),
    revision: 1,
    revisedBy: "mac",
    deleted: false,
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
    ...patch,
  });

  it("ends in one result whatever order concurrent changes merge in", () => {
    const renamedOnMac = entry({ name: "Night", revision: 2, revisedBy: "mac" });
    const deletedOnPc = entry({ deleted: true, revision: 2, revisedBy: "pc" });
    expect(winningThemeEntry(renamedOnMac, deletedOnPc)).toBe(deletedOnPc);
    expect(winningThemeEntry(deletedOnPc, renamedOnMac)).toBe(deletedOnPc);
    const restored = entry({ revision: 3, revisedBy: "mac" });
    expect(winningThemeEntry(deletedOnPc, restored)).toBe(restored);
  });

  it("keeps duplicates that share content apart", () => {
    const original = entry({});
    const duplicate = entry({ entryId: "e2", name: "Aurora copy" });
    const plan = reconcileThemeLibraries(
      [original, duplicate],
      [entry({ deleted: true, revision: 2 })],
    );
    expect(plan.takeFromOther.map((item) => item.entryId)).toEqual(["e1"]);
    expect(plan.sendToOther.map((item) => item.entryId)).toEqual(["e2"]);
  });
});
