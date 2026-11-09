import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync, inflateSync } from "node:zlib";

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
import { themeForSharing } from "./sharing.ts";
import {
  plainPng,
  showcasePngProblems,
  showcaseSlugFor,
  themeShowcaseProblems,
  unknownThemeFields,
} from "./showcase.ts";
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

  it("refuses a theme whose popover text is its fill, and names unknown overrides to an agent", () => {
    const check = checkThemeManifest(
      {
        ...aurora,
        overrides: {
          "popover-foreground": "#1c243f",
          popover: "#1c243f",
          "not-a-token": "#ffffff",
        },
      },
      { authoring: true },
    );
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.contrast.map((failure) => failure.id)).toContain("foreground/popover");
    expect(check.errors.some((error) => error.includes('"not-a-token"'))).toBe(true);
    // Saved, synced or imported, it may be a newer build's token: kept, unused here.
    const newer = checkThemeManifest({ ...aurora, overrides: { "not-a-token": "#ffffff" } });
    expect(newer.ok ? newer.manifest.overrides : newer.errors).toEqual({
      "not-a-token": "#ffffff",
    });
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
    // A license goes with the content it covers: a credited copy is its own.
    expect(
      await themeContentHash({ ...aurora, credits: { author: "Mira", license: "CC0-1.0" } }),
    ).not.toBe(hash);
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

/** Base64 of bytes, as a theme file embeds them. */
const base64 = (bytes: ReadonlyArray<number>) => btoa(String.fromCharCode(...bytes));

/** A PNG's signature and IHDR chunk saying width × height: enough for the check to read its size. */
const pngHead = (width: number, height: number) => {
  const be32 = (value: number) => [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ];
  return `data:image/png;base64,${base64([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    0x49,
    0x48,
    0x44,
    0x52,
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ])}`;
};

describe("files a theme embeds", () => {
  const withFiles = (font: string, still: string): ThemeManifest => ({
    ...aurora,
    fonts: { mono: { family: "Geist Mono", source: "google", data: font } },
    glass: { frame: 0.4, list: 0.5, column: 0.4, composer: 0.7, blur: 22 },
    backdrop: { mode: "grid", script: "x", maxFps: 15, still },
  });
  const errors = (manifest: ThemeManifest) => {
    const check = checkThemeManifest(manifest);
    return check.ok ? [] : check.errors;
  };
  const woff2 = base64([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0]);

  it("takes a font only when it is WOFF2, and a still only when it is a PNG of a size that opens", () => {
    expect(errors(withFiles(woff2, pngHead(1440, 900)))).toEqual([]);
    // Padding is optional, as the app's font loader reads it.
    expect(errors(withFiles(woff2.replace(/=+$/, ""), pngHead(1440, 900)))).toEqual([]);
    // Labeled right, holding something else: a TrueType font, text, broken base64.
    expect(errors(withFiles(base64([0, 1, 0, 0, 0, 0, 0, 0]), pngHead(1440, 900)))).toEqual([
      "The mono font isn't a WOFF2 font file.",
    ]);
    expect(errors(withFiles("not base64!", pngHead(1440, 900)))).toEqual([
      "The mono font isn't a WOFF2 font file.",
    ]);
    expect(errors(withFiles(woff2, `data:image/png;base64,${btoa("<svg/>")}`))).toEqual([
      "The backdrop still isn't a PNG picture.",
    ]);
    // A few bytes can claim a picture far too big to open.
    expect(errors(withFiles(woff2, pngHead(30_000, 30_000)))).toEqual([
      "The backdrop still is 30000×30000 pixels; the most is 4096 on a side and 9216000 in all.",
    ]);
  });
});

describe("fields a newer build added", () => {
  // As a newer build would write it: a field at the top, one inside glass.
  const newer = {
    ...aurora,
    glass: { frame: 0.4, list: 0.5, column: 0.4, composer: 0.7, blur: 22, sheen: 0.3 },
    backdrop: { mode: "grid", script: "x", maxFps: 15 },
    soundscape: { kind: "rain", volume: 0.2 },
  };

  it("are kept through the check, counted in the hash, and shared along", async () => {
    const check = checkThemeManifest(newer);
    if (!check.ok) return expect.fail(check.errors.join("\n"));
    expect(check.manifest).toMatchObject({
      soundscape: { kind: "rain", volume: 0.2 },
      glass: { sheen: 0.3 },
    });
    // Two builds that carry the field hash it alike; one that dropped it would not.
    const { soundscape: _dropped, ...older } = newer;
    expect(await themeContentHash(check.manifest)).not.toBe(
      await themeContentHash(older as ThemeManifest),
    );
    const shared = themeForSharing(check.manifest, {
      name: "Newer",
      includePrompt: false,
      credits: null,
    });
    expect(shared).toMatchObject({ soundscape: { kind: "rain", volume: 0.2 } });
  });

  it("ride along unchecked where a part holds colors or fonts, and in credits", () => {
    const check = checkThemeManifest({
      ...newer,
      code: { keyword: "#c792ea", ligatures: { on: true } },
      fonts: { emoji: { family: "Noto", data: 7 } },
      credits: { author: "Mira", pronouns: "she/her" },
    });
    if (!check.ok) return expect.fail(check.errors.join("\n"));
    const shared = themeForSharing(check.manifest, {
      name: "Newer",
      includePrompt: false,
      credits: null,
    });
    expect(shared.credits).toEqual({ author: "Mira", pronouns: "she/her" });
  });

  it("can't nest deeper than anything that walks them can follow", () => {
    let deep: unknown = "end";
    for (let level = 0; level < 50_000; level++) deep = [deep];
    const check = checkThemeManifest({ ...newer, soundscape: deep });
    expect(check.ok ? [] : check.errors).toEqual([
      "The theme nests its data more than 32 levels deep, or holds more than 500000 values.",
    ]);
  });
});

describe("sharing a theme", () => {
  const made: ThemeManifest = {
    ...aurora,
    prompt: "a winter night over a quiet town",
    createdBy: { kind: "agent", agent: "Claude", threadId: "thread-private" },
  };

  it("never says which thread made it, and keeps the prompt only when asked", () => {
    const shared = themeForSharing(made, { name: "Winter", includePrompt: false, credits: null });
    expect(shared.name).toBe("Winter");
    expect(shared).not.toHaveProperty("createdBy");
    expect(shared).not.toHaveProperty("prompt");
    expect(shared).not.toHaveProperty("credits");
    expect(
      themeForSharing(made, { name: "Winter", includePrompt: true, credits: null }).prompt,
    ).toBe(made.prompt);
  });

  it("takes its author's credits, but passes on credits a theme already has", () => {
    const mine = themeForSharing(made, {
      name: "Winter",
      includePrompt: false,
      credits: { author: "  Will ", link: " ", license: "CC-BY-4.0" },
    });
    expect(mine.credits).toEqual({ author: "Will", license: "CC-BY-4.0" });
    // Someone else's theme, shared on: its credit is theirs.
    const reshared = themeForSharing(
      { ...made, credits: { author: "Mira", license: "CC0-1.0" } },
      { name: "Winter", includePrompt: false, credits: { author: "Will", license: "CC-BY-4.0" } },
    );
    expect(reshared.credits).toEqual({ author: "Mira", license: "CC0-1.0" });
  });
});

describe("the Showcase", () => {
  const credited: ThemeManifest = { ...aurora, credits: { author: "Mira", license: "CC-BY-4.0" } };

  it("takes only fields this build knows, an open license, and no trace of the thread", () => {
    expect(themeShowcaseProblems(credited)).toEqual([]);
    expect(
      unknownThemeFields({
        ...credited,
        glass: { frame: 0.4, list: 0.5, column: 0.4, composer: 0.7, blur: 22, sheen: 0.3 },
        fonts: { emoji: { family: "Noto", source: "system" } },
        credits: { author: "Mira", pronouns: "she/her" },
        soundscape: { kind: "rain" },
      } as ThemeManifest),
    ).toEqual(["soundscape", "fonts.emoji", "glass.sheen", "credits.pronouns"]);
    expect(
      themeShowcaseProblems({ ...credited, createdBy: { kind: "agent", threadId: "t-1" } }),
    ).toHaveLength(1);
    expect(themeShowcaseProblems(aurora)).toEqual([
      "Pick a license others can use it under: CC BY 4.0 or CC0.",
    ]);
    expect(
      themeShowcaseProblems({ ...aurora, credits: { author: "Threadlines", license: "MIT" } })[0],
    ).toMatch(/starter's MIT license/);
  });

  it("takes a picture only as a plain PNG of its size, and drops what a screenshot adds", () => {
    const chunk = (type: string, data: Uint8Array) => {
      const out = Buffer.alloc(12 + data.length);
      out.writeUInt32BE(data.length, 0);
      out.write(type, 4, "latin1");
      out.set(data, 8);
      out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
      return out;
    };
    const png = (width: number, extra: Buffer[] = []) => {
      const header = Buffer.alloc(13);
      header.writeUInt32BE(width, 0);
      header.writeUInt32BE(200, 4);
      header.set([8, 2, 0, 0, 0], 8);
      return new Uint8Array(
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          chunk("IHDR", header),
          ...extra,
          chunk("IDAT", deflateSync(Buffer.alloc(200 * (1 + width * 3)))),
          chunk("IEND", new Uint8Array()),
        ]),
      );
    };
    const limits = { width: 320, height: 200, maxBytes: 160 * 1024 };
    const text = chunk("tEXt", Buffer.from("Comment\0from the thread"));
    expect(showcasePngProblems(png(320), limits)).toEqual([]);
    expect(showcasePngProblems(png(320, [text]), limits)).toEqual([
      "The picture carries extra data (a tEXt chunk).",
    ]);
    expect(showcasePngProblems(png(321), limits)).toEqual([
      "The picture is 321×200; it must be 320×200.",
    ]);
    expect(showcasePngProblems(new Uint8Array([...png(320), 0]), limits)).toEqual([
      "The picture has data after its end.",
    ]);
    // A header and an end with nothing between, or a byte changed in transit.
    const empty = png(320).filter((_, index, all) => {
      const idat = Buffer.from(all).indexOf("IDAT") - 4;
      const length = Buffer.from(all).readUInt32BE(idat);
      return index < idat || index >= idat + 12 + length;
    });
    expect(showcasePngProblems(empty, limits)).toEqual(["The picture has no image in it."]);
    // Image data that unpacks to fewer rows than the header promises.
    const short = Buffer.from(png(320));
    const idat = short.indexOf("IDAT") - 4;
    const shortData = chunk("IDAT", deflateSync(Buffer.alloc(10)));
    const shortPng = new Uint8Array(
      Buffer.concat([
        short.subarray(0, idat),
        shortData,
        short.subarray(idat + 12 + short.readUInt32BE(idat)),
      ]),
    );
    expect(showcasePngProblems(shortPng, limits)).toEqual([]);
    expect(showcasePngProblems(shortPng, limits, inflateSync)).toEqual([
      "The picture's image data is damaged.",
    ]);
    expect(showcasePngProblems(png(320), limits, inflateSync)).toEqual([]);
    const damaged = png(320);
    damaged[40] = damaged[40]! ^ 0xff;
    expect(showcasePngProblems(damaged, limits)).toEqual([
      "The picture is damaged: a part of it doesn't match its checksum.",
    ]);
    // A screenshot's text is dropped; a chunk the picture can't do without refuses it.
    expect(plainPng(png(320, [text]))).toEqual(png(320));
    expect(plainPng(png(320, [chunk("ZZZZ", new Uint8Array(1))]))).toBeNull();
  });

  it("names a theme's folder from its name, apart from the folders taken", () => {
    expect(showcaseSlugFor("Tide Pool!", new Set())).toBe("tide-pool");
    expect(showcaseSlugFor("Tide Pool", new Set(["tide-pool", "tide-pool-2"]))).toBe("tide-pool-3");
    expect(showcaseSlugFor("Café Noir", new Set())).toBe("cafe-noir");
    expect(showcaseSlugFor("東京", new Set())).toBe("theme");
    expect(showcaseSlugFor("--Night  Owl--", new Set())).toBe("night-owl");
    expect(showcaseSlugFor(`${"a".repeat(35)} b`, new Set())).toBe("a".repeat(35));
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
