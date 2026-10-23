import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  BRAND_ASSET_PATHS,
  DEVELOPMENT_ICON_OVERRIDES,
  PUBLISH_ICON_OVERRIDES,
  resolveWebAssetBrandForChannel,
  resolveWebIconOverrides,
} from "./brand-assets.ts";

describe("brand-assets", () => {
  it("maps server publish web assets to production icons", () => {
    expect(PUBLISH_ICON_OVERRIDES).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFaviconIco,
        targetRelativePath: "dist/client/favicon.ico",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon16Png,
        targetRelativePath: "dist/client/favicon-16x16.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon32Png,
        targetRelativePath: "dist/client/favicon-32x32.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
        targetRelativePath: "dist/client/apple-touch-icon.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppIcon192Png,
        targetRelativePath: "dist/client/icon-192.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppIcon512Png,
        targetRelativePath: "dist/client/icon-512.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppIconMaskable512Png,
        targetRelativePath: "dist/client/icon-maskable-512.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppManifest,
        targetRelativePath: "dist/client/manifest.webmanifest",
      },
    ]);
  });

  it("gives each brand an install manifest named for its channel, whose icons are served beside it at their stated size", () => {
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const read = (relativePath: string) => readFileSync(`${repoRoot}${relativePath}`);
    for (const [brand, name] of [
      ["production", "Threadlines"],
      ["nightly", "Threadlines Nightly"],
      ["development", "Threadlines Dev"],
    ] as const) {
      const overrides = resolveWebIconOverrides(brand, "out");
      const servedAt = (path: string) =>
        overrides.find((override) => override.targetRelativePath === `out${path}`);
      const manifest = JSON.parse(
        read(servedAt("/manifest.webmanifest")!.sourceRelativePath).toString(),
      ) as {
        name: string;
        icons: ReadonlyArray<{ src: string; sizes: string }>;
      };
      expect(manifest.name).toBe(name);
      for (const icon of manifest.icons) {
        const served = servedAt(icon.src);
        expect(served, `${brand} serves ${icon.src}`).toBeDefined();
        // A PNG's width and height sit at bytes 16 and 20 of its header.
        const png = read(served!.sourceRelativePath);
        expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
      }
    }
    // The web app's own copies, which a dev server serves as they are, are production's.
    for (const override of resolveWebIconOverrides("production", "apps/web/public")) {
      expect(read(override.targetRelativePath).equals(read(override.sourceRelativePath))).toBe(
        true,
      );
    }
  });

  it("maps server build web assets to development icons", () => {
    expect(DEVELOPMENT_ICON_OVERRIDES[0]).toEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFaviconIco,
      targetRelativePath: "dist/client/favicon.ico",
    });
  });

  it("can target hosted web dist directly", () => {
    expect(resolveWebIconOverrides("production", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
      targetRelativePath: "apps/web/dist/apple-touch-icon.png",
    });
  });

  it("maps hosted nightly web assets to nightly icons", () => {
    expect(resolveWebIconOverrides("nightly", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
      targetRelativePath: "apps/web/dist/favicon.ico",
    });
  });

  it("maps hosted release channels to web asset brands", () => {
    expect(resolveWebAssetBrandForChannel("latest")).toBe("production");
    expect(resolveWebAssetBrandForChannel("nightly")).toBe("nightly");
  });
});
