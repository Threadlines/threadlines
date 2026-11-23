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

const BUILD_1_5_14 = "1.5.14-5302690847260672";

/**
 * Google's 1.5.14 builds, from the update feed on 2026-11-23. Sizes were
 * measured from the downloads, which matched the feed's sha512.
 */
export const ANTIGRAVITY_RELEASE: AntigravityRelease = {
  version: "1.5.14",
  assets: {
    "darwin-arm64": asset(
      "darwin-arm64",
      BUILD_1_5_14,
      "26830fd46bfb9200d073cf3e71bf94b707552557b4380ec01afd6e99f3a2b030e65422dab1867f77318078692defc859a7547d17ec4b0b1e9369f13c9c3caea6",
      85_943_943,
      229_152_672,
    ),
    "darwin-x64": asset(
      "darwin-x64",
      BUILD_1_5_14,
      "1b6a1fc6dbe46ba6d9d0405d1b6095189f35ebfc4c3c33ceb1fd1b6d0c9fd702b52ac10b64b8b52aed0d8d71ae02c5df3cffd5e3e3d37549c2daffcce2a853c7",
      91_613_810,
      238_884_352,
    ),
    "linux-arm64": asset(
      "linux-arm64",
      BUILD_1_5_14,
      "c9b29bba475f63a1a80161ae93ba72b221c7a586d9851e4d0061546704bab66d6b2760b25d716d191724fc7564f3246456ee151e28aa37af48dbcd72bdc6c463",
      92_116_379,
      256_070_320,
    ),
    "linux-x64": asset(
      "linux-x64",
      BUILD_1_5_14,
      "83311d3f354567612dc16c1ae2ea9b503d6f6833aa4e138d39aa229da3f3bb99b0e4d7cca0bce4796b0060d6a51d8113eb7449ed5dc0e7900bf217107ea5bff9",
      101_195_950,
      273_240_776,
    ),
    "linux-arm64-musl": asset(
      "linux-arm64-musl",
      BUILD_1_5_14,
      "f6e35fc3dab2cd49fd4296ddee0841b9cc4c7020b6c6aaea6452c5b3452b0ad8d66451c9098e418ad6b2f6eabcc81cdf13105ed043903248b11d6fb24ae709ab",
      87_901_519,
      231_767_616,
    ),
    "linux-x64-musl": asset(
      "linux-x64-musl",
      BUILD_1_5_14,
      "1da24922727c5b4e84369d0843575d7d6f180a1946e2dc4289171ad1e3ca92594e687724d1902a7d83e407f98f0a8d3b7c3e976f03680fd80dbed2d2da00c0ed",
      93_553_347,
      244_676_552,
    ),
    "win32-arm64": asset(
      "win32-arm64",
      BUILD_1_5_14,
      "b2ce5462cf1845b25c05ca651b5bd93735fd807f8e7b40c61d0e99445df1a76b97ee24c890d5f5ba0453f848ca174f74d492ad1901a2ddcba5d7a9b4399ddfef",
      226_082_456,
      undefined,
    ),
    "win32-x64": asset(
      "win32-x64",
      BUILD_1_5_14,
      "785548b23242ec9112759bb4b525d94a3d4d2e9868e5cedb9ea34e5ce01dbb00abf5de66c41d8f4903e8a4379445f685483f999ece91867bfbd9d4812760d835",
      238_615_704,
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
