export const BRAND_ASSET_PATHS = {
  productionMacIconPng: "assets/prod/threadlines-macos-1024.png",
  productionMacDarkIconPng: "assets/prod/threadlines-macos-dark-1024.png",
  productionMacLightIconPng: "assets/prod/threadlines-macos-light-1024.png",
  productionLinuxIconPng: "assets/prod/threadlines-universal-1024.png",
  productionWindowsIconIco: "assets/prod/threadlines-windows.ico",
  productionWebFaviconIco: "assets/prod/threadlines-web-favicon.ico",
  productionWebFavicon16Png: "assets/prod/threadlines-web-favicon-16x16.png",
  productionWebFavicon32Png: "assets/prod/threadlines-web-favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/prod/threadlines-web-apple-touch-180.png",
  productionWebAppIcon192Png: "assets/prod/threadlines-web-icon-192.png",
  productionWebAppIcon512Png: "assets/prod/threadlines-web-icon-512.png",
  productionWebAppIconMaskable512Png: "assets/prod/threadlines-web-icon-maskable-512.png",
  productionWebAppManifest: "assets/prod/threadlines-web.webmanifest",

  nightlyMacIconPng: "assets/nightly/threadlines-nightly-macos-1024.png",
  nightlyMacDarkIconPng: "assets/nightly/threadlines-nightly-macos-dark-1024.png",
  nightlyMacLightIconPng: "assets/nightly/threadlines-nightly-macos-light-1024.png",
  nightlyLinuxIconPng: "assets/nightly/threadlines-nightly-universal-1024.png",
  nightlyWindowsIconIco: "assets/nightly/threadlines-nightly-windows.ico",
  nightlyWebFaviconIco: "assets/nightly/threadlines-nightly-web-favicon.ico",
  nightlyWebFavicon16Png: "assets/nightly/threadlines-nightly-web-favicon-16x16.png",
  nightlyWebFavicon32Png: "assets/nightly/threadlines-nightly-web-favicon-32x32.png",
  nightlyWebAppleTouchIconPng: "assets/nightly/threadlines-nightly-web-apple-touch-180.png",
  nightlyWebAppIcon192Png: "assets/nightly/threadlines-nightly-web-icon-192.png",
  nightlyWebAppIcon512Png: "assets/nightly/threadlines-nightly-web-icon-512.png",
  nightlyWebAppIconMaskable512Png: "assets/nightly/threadlines-nightly-web-icon-maskable-512.png",
  nightlyWebAppManifest: "assets/nightly/threadlines-nightly-web.webmanifest",

  developmentDesktopIconPng: "assets/dev/threadlines-dev-macos-1024.png",
  developmentDesktopDarkIconPng: "assets/dev/threadlines-dev-macos-dark-1024.png",
  developmentDesktopLightIconPng: "assets/dev/threadlines-dev-macos-light-1024.png",
  developmentWindowsIconIco: "assets/dev/threadlines-dev-windows.ico",
  developmentWebFaviconIco: "assets/dev/threadlines-dev-web-favicon.ico",
  developmentWebFavicon16Png: "assets/dev/threadlines-dev-web-favicon-16x16.png",
  developmentWebFavicon32Png: "assets/dev/threadlines-dev-web-favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/dev/threadlines-dev-web-apple-touch-180.png",
  developmentWebAppIcon192Png: "assets/dev/threadlines-dev-web-icon-192.png",
  developmentWebAppIcon512Png: "assets/dev/threadlines-dev-web-icon-512.png",
  developmentWebAppIconMaskable512Png: "assets/dev/threadlines-dev-web-icon-maskable-512.png",
  developmentWebAppManifest: "assets/dev/threadlines-dev-web.webmanifest",
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

/**
 * The web build's brand files, by the name they are served under. The install
 * manifest is one of them: it names the installed app after its channel
 * ("Threadlines Nightly"), and its icons are the files beside it.
 */
const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
  appIcon192Png: "icon-192.png",
  appIcon512Png: "icon-512.png",
  appIconMaskable512Png: "icon-maskable-512.png",
  appManifest: "manifest.webmanifest",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
    appIcon192Png: BRAND_ASSET_PATHS.developmentWebAppIcon192Png,
    appIcon512Png: BRAND_ASSET_PATHS.developmentWebAppIcon512Png,
    appIconMaskable512Png: BRAND_ASSET_PATHS.developmentWebAppIconMaskable512Png,
    appManifest: BRAND_ASSET_PATHS.developmentWebAppManifest,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
    appIcon192Png: BRAND_ASSET_PATHS.nightlyWebAppIcon192Png,
    appIcon512Png: BRAND_ASSET_PATHS.nightlyWebAppIcon512Png,
    appIconMaskable512Png: BRAND_ASSET_PATHS.nightlyWebAppIconMaskable512Png,
    appManifest: BRAND_ASSET_PATHS.nightlyWebAppManifest,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
    appIcon192Png: BRAND_ASSET_PATHS.productionWebAppIcon192Png,
    appIcon512Png: BRAND_ASSET_PATHS.productionWebAppIcon512Png,
    appIconMaskable512Png: BRAND_ASSET_PATHS.productionWebAppIconMaskable512Png,
    appManifest: BRAND_ASSET_PATHS.productionWebAppManifest,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return (
    Object.keys(WEB_ICON_TARGET_FILENAMES) as Array<keyof typeof WEB_ICON_TARGET_FILENAMES>
  ).map((asset) => ({
    sourceRelativePath: sourcePaths[asset],
    targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES[asset]}`,
  }));
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const PUBLISH_ICON_OVERRIDES = resolveWebIconOverrides("production", "dist/client");
