/**
 * AntigravityRelease — the pinned Antigravity ACP server release Threadlines
 * installs, one zip per platform.
 *
 * Each zip holds exactly two files: the ACP server and the local harness it
 * starts. The sizes and hashes below were taken from the published archives;
 * the runtime refuses anything that differs.
 *
 * @module provider/antigravity/AntigravityRelease
 */

export type AntigravityAssetKey =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "win32-arm64"
  | "win32-x64";

export interface AntigravityReleaseFile {
  /** Entry name in the zip and file name on disk. */
  readonly name: string;
  readonly bytes: number;
}

export interface AntigravityReleaseAsset {
  readonly url: string;
  /** Lowercase hex sha256 of the zip. */
  readonly sha256: string;
  readonly archiveBytes: number;
  /** The ACP server Threadlines launches. */
  readonly executable: AntigravityReleaseFile;
  /** The local harness the ACP server starts. */
  readonly harness: AntigravityReleaseFile;
}

export interface AntigravityRelease {
  readonly version: string;
  readonly assets: Readonly<Record<AntigravityAssetKey, AntigravityReleaseAsset>>;
}

/** One platform's pinned download, as `makeAntigravityRuntime` installs it. */
export interface AntigravityPlatformRelease {
  readonly version: string;
  readonly asset: AntigravityReleaseAsset;
}

const POSIX_FILES = (executableBytes: number, harnessBytes: number) => ({
  executable: { name: "agy_acp_server.par", bytes: executableBytes },
  harness: { name: "localharness_external", bytes: harnessBytes },
});

const WINDOWS_FILES = (executableBytes: number, harnessBytes: number) => ({
  executable: { name: "agy_acp_server.exe", bytes: executableBytes },
  harness: { name: "localharness_external.exe", bytes: harnessBytes },
});

const RELEASES_URL = "https://dl.google.com/agy-extensions/releases";

/** Registry entry `antigravity-acp` 1.3.0. */
export const ANTIGRAVITY_RELEASE: AntigravityRelease = {
  version: "1.3.0",
  assets: {
    "darwin-arm64": {
      url: `${RELEASES_URL}/macos/agy-acp-server-1.3.0-darwin-arm64.zip`,
      sha256: "7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88",
      archiveBytes: 111_456_962,
      ...POSIX_FILES(278_535_456, 118_611_392),
    },
    "darwin-x64": {
      url: `${RELEASES_URL}/macos/agy-acp-server-1.3.0-darwin-x86_64.zip`,
      sha256: "bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646",
      archiveBytes: 117_245_544,
      ...POSIX_FILES(282_840_688, 124_175_392),
    },
    "linux-arm64": {
      url: `${RELEASES_URL}/linux/agy-acp-server-1.3.0-linux-arm64.zip`,
      sha256: "500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf",
      archiveBytes: 321_690_363,
      ...POSIX_FILES(930_848_992, 123_224_968),
    },
    "linux-x64": {
      url: `${RELEASES_URL}/linux/agy-acp-server-1.3.0-linux-x86_64.zip`,
      sha256: "9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96",
      archiveBytes: 333_727_150,
      ...POSIX_FILES(926_533_965, 130_388_040),
    },
    "win32-arm64": {
      url: `${RELEASES_URL}/windows/agy-acp-server-1.3.0-windows-arm64.zip`,
      sha256: "4a0f469720e9beb9438a979f543fdbfad5022ebe0992c052c590bd78b3144ca3",
      archiveBytes: 124_654_803,
      ...WINDOWS_FILES(85_893_472, 135_640_216),
    },
    "win32-x64": {
      url: `${RELEASES_URL}/windows/agy-acp-server-1.3.0-windows-x86_64.zip`,
      sha256: "65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9",
      archiveBytes: 124_509_787,
      ...WINDOWS_FILES(81_437_336, 145_548_952),
    },
  },
};

/** The asset key for a Node platform and `process.arch`, or undefined when there is no build. */
export function antigravityAssetKey(
  platform: NodeJS.Platform,
  arch: string,
): AntigravityAssetKey | undefined {
  if (arch !== "arm64" && arch !== "x64") return undefined;
  switch (platform) {
    case "darwin":
    case "linux":
    case "win32":
      return `${platform}-${arch}`;
    default:
      return undefined;
  }
}

/** The pinned release for this machine, or undefined when there is no build for it. */
export function antigravityReleaseFor(
  platform: NodeJS.Platform,
  arch: string,
): (AntigravityPlatformRelease & { readonly assetKey: AntigravityAssetKey }) | undefined {
  const assetKey = antigravityAssetKey(platform, arch);
  if (!assetKey) return undefined;
  return {
    assetKey,
    version: ANTIGRAVITY_RELEASE.version,
    asset: ANTIGRAVITY_RELEASE.assets[assetKey],
  };
}

/**
 * Short, path-safe id for an asset: the first 16 hex digits of its sha256.
 * Names the version directory, so it stays short for Windows MAX_PATH.
 */
export function antigravityReleaseId(asset: Pick<AntigravityReleaseAsset, "sha256">): string {
  return asset.sha256.slice(0, 16).toLowerCase();
}

/** Arguments the ACP server is launched with. Linux builds take an empty `--uid=`. */
export function antigravityLaunchArgs(platform: NodeJS.Platform): ReadonlyArray<string> {
  return platform === "linux" ? ["--uid="] : [];
}
