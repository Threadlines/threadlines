import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  HERO_THUMB_MAX_BYTES,
  heroArtPayload,
  heroThemeCss,
  heroThemes,
  heroThumbnails,
  SHOWCASE_FILE_SHA256,
} from "./heroThemes";

describe("hero themes", () => {
  it("keeps the Showcase files byte for byte as published", () => {
    for (const [id, expected] of Object.entries(SHOWCASE_FILE_SHA256)) {
      const bytes = readFileSync(
        new URL(`../themes/showcase/${id}.threadlines-theme`, import.meta.url),
      );
      expect(createHash("sha256").update(bytes).digest("hex"), id).toBe(expected);
    }
  });

  it("resolves every offered theme, and every art payload is complete and carries no still", () => {
    const themes = heroThemes();
    expect(themes.map((theme) => theme.id)).toContain("default");
    for (const theme of themes.filter((candidate) => candidate.hasArt)) {
      const payload = heroArtPayload(theme);
      const json = JSON.stringify(payload);
      expect(json, theme.id).not.toContain('"still"');
      expect(json, theme.id).not.toContain("data:image");
      expect(payload.init.script.length, theme.id).toBeGreaterThan(0);
      expect(payload.init.textColors.length, theme.id).toBe(payload.init.textRatios.length);
      for (const zone of Object.values(payload.zones)) {
        expect(zone.tint, theme.id).toBeGreaterThanOrEqual(0);
        expect(zone.tint, theme.id).toBeLessThan(1);
        expect(zone.color, theme.id).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
    expect(heroThemeCss(themes)).toContain('html[data-hero-theme="default"] :is(.hw, .hw-tokens)');
  });

  it("loads theme fonts with the page and keeps a theme's scheme inside the window", () => {
    const themes = heroThemes();
    const css = heroThemeCss(themes);
    const fonts = themes.flatMap((theme) => [theme.fonts.ui, theme.fonts.mono]).filter(Boolean);
    expect(fonts.length).toBeGreaterThan(0);
    expect(css.match(/@font-face/g)?.length).toBe(fonts.length);
    for (const theme of themes.filter((candidate) => candidate.base !== null)) {
      // On the window's children, never the window: its edge and shadow follow the page's scheme.
      expect(css, theme.id).toContain(
        `html[data-hero-theme="${theme.id}"] :is(.hw, .hw-tokens) > *{color-scheme:${theme.base};}`,
      );
      expect(css, theme.id).not.toContain(
        `html[data-hero-theme="${theme.id}"] :is(.hw, .hw-tokens){color-scheme`,
      );
    }
  });

  it("has a small picture for every theme with art in the theme strip", async () => {
    const thumbs = await heroThumbnails();
    for (const theme of heroThemes().filter((candidate) => candidate.hasArt)) {
      const bytes = thumbs.get(theme.id);
      expect(bytes, theme.id).toBeDefined();
      // WebP: "RIFF" .... "WEBP"
      expect(Buffer.from(bytes!.slice(8, 12)).toString("ascii"), theme.id).toBe("WEBP");
      expect(bytes!.byteLength, theme.id).toBeLessThanOrEqual(HERO_THUMB_MAX_BYTES);
    }
    expect(thumbs.has("default")).toBe(false);
  });
});
