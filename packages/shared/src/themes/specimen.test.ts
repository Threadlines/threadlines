import { THEME_FILE_FORMAT, type ThemeManifest } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThemeArtDocument, buildThemeSpecimenDocument } from "./specimen.ts";

const theme: ThemeManifest = {
  format: THEME_FILE_FORMAT,
  name: "Night",
  base: "dark",
  colors: {
    background: "#0a1029",
    foreground: "#e7ecff",
    mutedForeground: "#a3aed2",
    accent: "#2fd6b0",
    accentForeground: "#03231c",
  },
  glass: { frame: 0.6, list: 0.7, column: 0.85, composer: 0.85, blur: 16 },
};

const scripts = (document: string) => document.match(/<script>/g)?.length ?? 0;

describe("buildThemeSpecimenDocument", () => {
  it("keeps what a theme file says from becoming markup, styles or script", () => {
    const document = buildThemeSpecimenDocument({
      manifest: {
        ...theme,
        name: "</title><script>alert(1)</script>",
        fonts: { ui: { family: 'Inter"; } body { color: red', source: "system" } },
        backdrop: {
          mode: "grid",
          maxFps: 24,
          script: "</script><script>alert(2)</script>",
          still: 'data:image/png;base64,AAAA");} body{background:red',
        },
      },
      layout: "thread",
      width: 1440,
      height: 900,
    });
    expect(document).not.toContain("<script>alert");
    expect(document).not.toContain("color: red");
    expect(document).not.toContain("background:red");
    // Only the specimen's own bridge script.
    expect(scripts(document)).toBe(1);
  });

  it("runs live art in a sandboxed frame, and shows the still or nothing otherwise", () => {
    const live = buildThemeArtDocument({
      manifest: { ...theme, backdrop: { mode: "pixels", maxFps: 12, script: "draw()" } },
    });
    expect(live).toContain('"allow-scripts"');
    expect(live).toContain('"type":"init"');
    const still = buildThemeSpecimenDocument({
      manifest: {
        ...theme,
        backdrop: {
          mode: "pixels",
          maxFps: 12,
          script: "draw()",
          still: "data:image/png;base64,AAAA",
        },
      },
      layout: "new-thread",
      width: 1440,
      height: 900,
      art: "still",
    });
    expect(scripts(still)).toBe(0);
    expect(still).toContain("url(data:image/png;base64,AAAA)");
    expect(
      scripts(
        buildThemeSpecimenDocument({ manifest: theme, layout: "thread", width: 1440, height: 900 }),
      ),
    ).toBe(0);
  });
});
