// @effect-diagnostics globalConsole:off globalDate:off globalTimers:off nodeBuiltinImport:off
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Builds the macOS adaptive app icon (`Assets.car`) from the light/dark brand
 * artwork using Apple's Icon Composer `.icon` document format.
 *
 * macOS 26 (Tahoe) picks the icon appearance from the system-wide
 * "Icon & Widget style" setting, which has no public read API. Shipping an
 * `Assets.car` with per-appearance icon groups is the only way for the Dock,
 * Finder, and Launchpad to switch the icon with that setting — runtime
 * `app.dock.setIcon(...)` bitmaps cannot participate.
 */

export const MAC_ADAPTIVE_ICON_NAME = "AppIcon";
export const MAC_ADAPTIVE_ICON_ASSETS_CAR_FILE_NAME = "Assets.car";
const MAC_ADAPTIVE_ICON_DEFAULT_MINIMUM_SYSTEM_VERSION = "12.0";

// Plate colors sampled from the light/dark macOS icon sources in assets/. The
// dark plate is the app's dark --card token (oklch(0.292 0 0), ~#2C2C2C) so it
// sits alongside Apple's dark icon tiles; the light plate mirrors the light
// --background token. The fill only shows through the transparent corners of
// the layered artwork, so it must match the artwork's plate color exactly.
const LIGHT_APPEARANCE_FILL = "srgb:0.97255,0.97255,0.97255,1.00000";
const DARK_APPEARANCE_FILL = "srgb:0.17255,0.17255,0.17255,1.00000";

const LIGHT_LAYER_IMAGE_FILE_NAME = "light.png";
const DARK_LAYER_IMAGE_FILE_NAME = "dark.png";

export interface MacAdaptiveIconInput {
  readonly lightSourcePng: string;
  readonly darkSourcePng: string;
  /** Directory that receives `Assets.car` (created if missing). */
  readonly outputDir: string;
  readonly minimumSystemVersion?: string;
  readonly log?: (message: string) => void;
}

export interface MacAdaptiveIconOutput {
  readonly assetsCarPath: string;
}

/**
 * Icon Composer `icon.json` document: one artwork layer that swaps between the
 * light and dark renderings per system appearance, over a matching plate fill.
 * Glass/specular/shadow effects are disabled so the compiled icon reproduces
 * the flat brand artwork exactly.
 */
export function composeMacAdaptiveIconDocument(): Record<string, unknown> {
  return {
    "fill-specializations": [
      { value: { solid: LIGHT_APPEARANCE_FILL } },
      { appearance: "dark", value: { solid: DARK_APPEARANCE_FILL } },
    ],
    groups: [
      {
        layers: [
          {
            glass: false,
            hidden: false,
            "image-name-specializations": [
              { value: LIGHT_LAYER_IMAGE_FILE_NAME },
              { appearance: "dark", value: DARK_LAYER_IMAGE_FILE_NAME },
            ],
            name: "Artwork",
            position: {
              scale: 1,
              "translation-in-points": [0, 0],
            },
          },
        ],
        shadow: { kind: "none", opacity: 0.5 },
        specular: false,
        translucency: { enabled: false, value: 0.5 },
      },
    ],
    "supported-platforms": { squares: "shared" },
  };
}

/**
 * Compiling `.icon` documents requires actool from Xcode 26 or newer; the
 * Command Line Tools alone do not ship actool.
 */
export function isMacAdaptiveIconToolchainAvailable(): boolean {
  if (process.platform !== "darwin") {
    return false;
  }

  const probe = spawnSync("xcrun", ["--find", "actool"], { stdio: "ignore" });
  return probe.status === 0;
}

/**
 * Compiles the adaptive icon into `<outputDir>/Assets.car`. Returns null when
 * the icon cannot be built (non-macOS host, missing sources, actool missing or
 * too old to understand `.icon` documents) so callers can fall back to static
 * icon behavior.
 */
export function buildMacAdaptiveIconSync(
  input: MacAdaptiveIconInput,
): MacAdaptiveIconOutput | null {
  const log = input.log ?? (() => {});

  if (process.platform !== "darwin") {
    log("Skipping macOS adaptive icon: not building on macOS.");
    return null;
  }

  for (const source of [input.lightSourcePng, input.darkSourcePng]) {
    if (!existsSync(source)) {
      log(`Skipping macOS adaptive icon: source artwork is missing at ${source}.`);
      return null;
    }
  }

  if (!isMacAdaptiveIconToolchainAvailable()) {
    log("Skipping macOS adaptive icon: actool is unavailable (requires Xcode 26 or newer).");
    return null;
  }

  const scratchDir = mkdtempSync(join(tmpdir(), "threadlines-mac-adaptive-icon-"));
  try {
    const iconPackageDir = join(scratchDir, `${MAC_ADAPTIVE_ICON_NAME}.icon`);
    const iconAssetsDir = join(iconPackageDir, "Assets");
    const compileDir = join(scratchDir, "compiled");
    mkdirSync(iconAssetsDir, { recursive: true });
    mkdirSync(compileDir, { recursive: true });

    copyFileSync(input.lightSourcePng, join(iconAssetsDir, LIGHT_LAYER_IMAGE_FILE_NAME));
    copyFileSync(input.darkSourcePng, join(iconAssetsDir, DARK_LAYER_IMAGE_FILE_NAME));
    writeFileSync(
      join(iconPackageDir, "icon.json"),
      `${JSON.stringify(composeMacAdaptiveIconDocument(), null, 2)}\n`,
    );

    try {
      execFileSync(
        "xcrun",
        [
          "actool",
          iconPackageDir,
          "--compile",
          compileDir,
          "--platform",
          "macosx",
          "--minimum-deployment-target",
          input.minimumSystemVersion ?? MAC_ADAPTIVE_ICON_DEFAULT_MINIMUM_SYSTEM_VERSION,
          "--app-icon",
          MAC_ADAPTIVE_ICON_NAME,
          "--output-partial-info-plist",
          join(scratchDir, "partial-info.plist"),
        ],
        { stdio: "pipe" },
      );
    } catch (error) {
      log(`Skipping macOS adaptive icon: actool failed to compile the icon (${String(error)}).`);
      return null;
    }

    const compiledCarPath = join(compileDir, MAC_ADAPTIVE_ICON_ASSETS_CAR_FILE_NAME);
    if (!existsSync(compiledCarPath)) {
      // actool exits zero but emits nothing when it does not understand the
      // .icon document (for example actool from Xcode 16).
      log("Skipping macOS adaptive icon: actool did not produce Assets.car (Xcode 26+ required).");
      return null;
    }

    mkdirSync(input.outputDir, { recursive: true });
    const assetsCarPath = join(input.outputDir, MAC_ADAPTIVE_ICON_ASSETS_CAR_FILE_NAME);
    copyFileSync(compiledCarPath, assetsCarPath);
    return { assetsCarPath };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}
