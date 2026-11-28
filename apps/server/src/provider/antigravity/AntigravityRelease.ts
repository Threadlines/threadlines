/**
 * AntigravityRelease — which build of Google's Antigravity CLI (`agy`)
 * Threadlines installs, and how it launches it as an ACP agent (`agy acp`).
 *
 * Google publishes one build per platform through the CLI's own update feed
 * (`antigravityFeedUrl`): a manifest naming the version, the download and
 * its sha512. Unix builds are a tar.gz holding one executable, `antigravity`;
 * Windows builds are the bare `.exe`. The built-in release below is what
 * installs when the feed can't be read, and the oldest version offered; its
 * sizes were measured from Google's downloads. A newer one the feed lists is
 * offered as an update (`parseAntigravityFeedManifest`), checked by its
 * sha512 and capped in size, since the feed lists no sizes.
 *
 * This module has no runtime imports: `scripts/check-upstream-drift.ts`
 * loads it with plain Node.
 *
 * @module provider/antigravity/AntigravityRelease
 */

/**
 * The oldest `agy` Threadlines starts sessions with, managed or custom.
 * From Google's changelog: 1.5.10 delivers what the agent does after a turn
 * ends (a background task or subagent waking it), 1.5.13 honors attached
 * file contents and runs commands in the session's folder, and 1.5.14
 * stops a network path in a file mention or rule from sending Windows
 * credentials to a remote host.
 */
export const ANTIGRAVITY_MIN_VERSION = "1.5.14";

export type AntigravityAssetKey =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "linux-arm64-musl"
  | "linux-x64-musl"
  | "win32-arm64"
  | "win32-x64";

export type AntigravityArchiveFormat = "tar.gz" | "exe";

export interface AntigravityReleaseAsset {
  readonly url: string;
  /** Lowercase hex sha512 of the download. */
  readonly sha512: string;
  readonly format: AntigravityArchiveFormat;
  /** Exact download size when known (the built-in release); otherwise capped. */
  readonly archiveBytes?: number;
  /** The executable's file name on disk, and its exact size when known. */
  readonly executable: { readonly name: string; readonly bytes?: number };
}

export interface AntigravityRelease {
  readonly version: string;
  readonly assets: Readonly<Record<AntigravityAssetKey, AntigravityReleaseAsset>>;
}

/** One platform's download, as `makeAntigravityRuntime` installs it. */
export interface AntigravityPlatformRelease {
  readonly version: string;
  readonly asset: AntigravityReleaseAsset;
}

/** The only host Antigravity is downloaded from. */
export const ANTIGRAVITY_DOWNLOAD_HOST = "storage.googleapis.com";
const DOWNLOAD_ROOT = `https://${ANTIGRAVITY_DOWNLOAD_HOST}/antigravity-public/antigravity-cli`;

/** The host of Google's update feed for the CLI. */
export const ANTIGRAVITY_FEED_HOST =
  "antigravity-cli-auto-updater-974169037036.us-central1.run.app";

/**
 * Per build: the feed's manifest name, Google's download folder, and the
 * download's file name.
 */
const BUILDS: Readonly<
  Record<
    AntigravityAssetKey,
    { readonly feed: string; readonly folder: string; readonly file: string }
  >
> = {
  "darwin-arm64": { feed: "darwin_arm64", folder: "darwin-arm", file: "cli_mac_arm64.tar.gz" },
  "darwin-x64": { feed: "darwin_amd64", folder: "darwin-x64", file: "cli_mac_x64.tar.gz" },
  "linux-arm64": { feed: "linux_arm64", folder: "linux-arm", file: "cli_linux_arm64.tar.gz" },
  "linux-x64": { feed: "linux_amd64", folder: "linux-x64", file: "cli_linux_x64.tar.gz" },
  "linux-arm64-musl": {
    feed: "linux_arm64_musl",
    folder: "linux-arm-musl",
    file: "cli_linux_arm64_musl.tar.gz",
  },
  "linux-x64-musl": {
    feed: "linux_amd64_musl",
    folder: "linux-x64-musl",
    file: "cli_linux_x64_musl.tar.gz",
  },
  "win32-arm64": { feed: "windows_arm64", folder: "windows-arm", file: "cli_windows_arm64.exe" },
  "win32-x64": { feed: "windows_amd64", folder: "windows-x64", file: "cli_windows_x64.exe" },
};

/** Where Google's update feed describes the newest build for this asset. */
export function antigravityFeedUrl(assetKey: AntigravityAssetKey): string {
  return `https://${ANTIGRAVITY_FEED_HOST}/manifests/${BUILDS[assetKey].feed}.json`;
}

const isWindowsKey = (assetKey: AntigravityAssetKey) => assetKey.startsWith("win32-");

/** The executable's name: the tarball's one entry, or `agy.exe` for the Windows download. */
export const antigravityExecutableName = (assetKey: AntigravityAssetKey) =>
  isWindowsKey(assetKey) ? "agy.exe" : "antigravity";

const BUILD_NUMBER = /^\d{1,24}$/u;

/** Whether `url` is Google's download of `version` for this build (any build number). */
export function isAntigravityDownloadUrl(
  url: string,
  version: string,
  assetKey: AntigravityAssetKey,
): boolean {
  const prefix = `${DOWNLOAD_ROOT}/${version}-`;
  if (!url.startsWith(prefix)) return false;
  const [build, folder, file, ...rest] = url.slice(prefix.length).split("/");
  const { folder: wantFolder, file: wantFile } = BUILDS[assetKey];
  return (
    rest.length === 0 &&
    build !== undefined &&
    BUILD_NUMBER.test(build) &&
    folder === wantFolder &&
    file === wantFile
  );
}

const asset = (
  assetKey: AntigravityAssetKey,
  build: string,
  sha512: string,
  archiveBytes: number,
  executableBytes: number | undefined,
): AntigravityReleaseAsset => {
  const { folder, file } = BUILDS[assetKey];
  const windows = isWindowsKey(assetKey);
  return {
    url: `${DOWNLOAD_ROOT}/${build}/${folder}/${file}`,
    sha512,
    format: windows ? "exe" : "tar.gz",
    archiveBytes,
    // The Windows download is the executable itself.
    executable: {
      name: antigravityExecutableName(assetKey),
      ...((windows ? archiveBytes : executableBytes) !== undefined
        ? { bytes: windows ? archiveBytes : executableBytes! }
        : {}),
    },
  };
};

const BUILD_1_5_19 = "1.5.19-4821414830800896";

/**
 * Google's 1.5.19 builds, from the update feed on 2026-11-28. Archive sizes
 * were measured from Google's download headers (`Content-Length`); Unix
 * executables are size-capped and measured by the installer.
 */
export const ANTIGRAVITY_RELEASE: AntigravityRelease = {
  version: "1.5.19",
  assets: {
    "darwin-arm64": asset(
      "darwin-arm64",
      BUILD_1_5_19,
      "d798b1b2f91eb88a43c304ea5075db13cb069f01219c3b9f370037dc2c89d7e6c36ee96f160f9019947c1f5b55e744d8102e8303271d618f70d71cdb0911b213",
      85_928_527,
      undefined,
    ),
    "darwin-x64": asset(
      "darwin-x64",
      BUILD_1_5_19,
      "c989fa40e36858cecebaa1223ed93fbb9aaaba6fbaf3697d5d397cd451b4eea9ba7cebb3b5a6faf8ddec6dbce3730bdfda98b1c182062a522a7b9ea875d30894",
      91_516_270,
      undefined,
    ),
    "linux-arm64": asset(
      "linux-arm64",
      BUILD_1_5_19,
      "eeecedfc2a63af281e245d73bb69f949a17c6d3ebcd3d023220056ddcc05e204a00d1d0ea77f68741b2fc15a1f66f740bc0e3bf800d734721c60938e61653010",
      94_382_838,
      undefined,
    ),
    "linux-x64": asset(
      "linux-x64",
      BUILD_1_5_19,
      "8160da6ceef2b7b62bb4a630b54b3fb4ee5283377509230736880c4ba4815e848a25cf346954a98134b647eb2f5d34e0364e77fbf74367ffd7dc29c525ddd82d",
      103_658_205,
      undefined,
    ),
    "linux-arm64-musl": asset(
      "linux-arm64-musl",
      BUILD_1_5_19,
      "e5fbc849f6288556b1d8b7e0d0a70b763dd404ff9673c5ec7921937955793283d91e931e48779b0e8ac39f6973bf6b53e763279eb88a0dbd1deab6da37a1e411",
      90_079_606,
      undefined,
    ),
    "linux-x64-musl": asset(
      "linux-x64-musl",
      BUILD_1_5_19,
      "8a5541bc71900e7571ce2c5cfc637e6155ace45f108badd91ee235c1e8f122c034bd07e1efc6f18a77467075419102d99d03ac5b8033e271e0914d05adf60634",
      95_963_524,
      undefined,
    ),
    "win32-arm64": asset(
      "win32-arm64",
      BUILD_1_5_19,
      "c0d8b034dc010b598139b301e7fec9f665538f08da6af3e8fa0868fb1f4ffcbe937d4e5bc6bb25d9f23b29908bc74cb444a10598b4021d1a0267be0467bee9c0",
      233_281_360,
      undefined,
    ),
    "win32-x64": asset(
      "win32-x64",
      BUILD_1_5_19,
      "122ce5ed90a0f0ec8a87fd3383e167ba4ab39afeb40ed8a302393f5da74c62883d915efa9fe8071eb2f00b37a1384354225b230ff345fac8d9d5bf70983ce1b8",
      246_379_312,
      undefined,
    ),
  },
};

/**
 * The asset key for a Node platform, `process.arch` and C library, or
 * undefined when Google publishes no build for it.
 */
export function antigravityAssetKey(
  platform: NodeJS.Platform,
  arch: string,
  libc: "glibc" | "musl" = "glibc",
): AntigravityAssetKey | undefined {
  if (arch !== "arm64" && arch !== "x64") return undefined;
  switch (platform) {
    case "linux":
      return libc === "musl" ? `linux-${arch}-musl` : `linux-${arch}`;
    case "darwin":
    case "win32":
      return `${platform}-${arch}`;
    default:
      return undefined;
  }
}

/** The built-in release for this machine, or undefined when there is no build for it. */
export function antigravityReleaseFor(
  platform: NodeJS.Platform,
  arch: string,
  libc: "glibc" | "musl" = "glibc",
): (AntigravityPlatformRelease & { readonly assetKey: AntigravityAssetKey }) | undefined {
  const assetKey = antigravityAssetKey(platform, arch, libc);
  if (!assetKey) return undefined;
  return {
    assetKey,
    version: ANTIGRAVITY_RELEASE.version,
    asset: ANTIGRAVITY_RELEASE.assets[assetKey],
  };
}

/**
 * Short, path-safe id for an asset: the first 16 hex digits of its sha512.
 * Names the version directory, so it stays short for Windows MAX_PATH.
 */
export function antigravityReleaseId(asset: Pick<AntigravityReleaseAsset, "sha512">): string {
  return asset.sha512.slice(0, 16).toLowerCase();
}

/** The agent's state folder inside the profile, as `--app-data-dir` names it. */
export const ANTIGRAVITY_APP_DATA_DIR = "antigravity-acp";

/**
 * `agy acp` for one instance's profile. The CLI joins `--app-data-dir`
 * beneath `--gemini-dir`, so a bare name keeps the agent's state there.
 */
export function antigravityLaunchArgs(profileDir: string): ReadonlyArray<string> {
  return ["acp", "--gemini-dir", profileDir, "--app-data-dir", ANTIGRAVITY_APP_DATA_DIR];
}

const PLAIN_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/u;
const SHA512_HEX = /^[0-9a-fA-F]{128}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A feed manifest (`{ version, url, sha512 }`) as a release Threadlines can
 * install for this build, or undefined when it isn't one: a plain version,
 * a sha512, and a download in Google's own folder for that version and
 * build, under the name Google uses. Anything else waits for a Threadlines
 * release that knows it. Sizes stay unknown: the install caps them.
 */
export function parseAntigravityFeedManifest(
  manifest: unknown,
  assetKey: AntigravityAssetKey,
): AntigravityPlatformRelease | undefined {
  if (!isRecord(manifest)) return undefined;
  const { version, url, sha512 } = manifest;
  if (
    typeof version !== "string" ||
    typeof url !== "string" ||
    typeof sha512 !== "string" ||
    !PLAIN_VERSION.test(version) ||
    !SHA512_HEX.test(sha512) ||
    !isAntigravityDownloadUrl(url, version, assetKey)
  ) {
    return undefined;
  }
  return {
    version,
    asset: {
      url,
      sha512: sha512.toLowerCase(),
      format: isWindowsKey(assetKey) ? "exe" : "tar.gz",
      executable: { name: antigravityExecutableName(assetKey) },
    },
  };
}
