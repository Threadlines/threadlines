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

/** Registry entry `antigravity-acp` 1.5.2. */
export const ANTIGRAVITY_RELEASE: AntigravityRelease = {
  version: "1.5.2",
  assets: {
    "darwin-arm64": {
      url: `${RELEASES_URL}/macos/agy-acp-server-1.5.2-darwin-arm64.zip`,
      sha256: "123a16d5c40a8ac99e20f01a62b68dd860fd96b1c528dfb8eaa37ca8733d4845",
      archiveBytes: 100_309_778,
      ...POSIX_FILES(179_921_328, 129_208_672),
    },
    "darwin-x64": {
      url: `${RELEASES_URL}/macos/agy-acp-server-1.5.2-darwin-x86_64.zip`,
      sha256: "92addb5580577b5356d35484d72d1a113d9c5312ad766bcb304983aa8e3fbb06",
      archiveBytes: 106_351_992,
      ...POSIX_FILES(184_312_784, 134_350_320),
    },
    "linux-arm64": {
      url: `${RELEASES_URL}/linux/agy-acp-server-1.5.2-linux-arm64.zip`,
      sha256: "e729e05ef54ef0763e48900032466b47fa7c9939cde257f93ba49410ab577acb",
      archiveBytes: 264_270_419,
      ...POSIX_FILES(721_649_155, 132_598_576),
    },
    "linux-x64": {
      url: `${RELEASES_URL}/linux/agy-acp-server-1.5.2-linux-x86_64.zip`,
      sha256: "99dd8612450805011619d7b8447ce374c289e00549d8557f36790e1dd6256852",
      archiveBytes: 273_964_075,
      ...POSIX_FILES(714_384_320, 139_194_456),
    },
    "win32-arm64": {
      url: `${RELEASES_URL}/windows/agy-acp-server-1.5.2-windows-arm64.zip`,
      sha256: "8a4b2ea8df2ffefae33309348752e9119d21a6d36090c0eb48631c2e8f5781ab",
      archiveBytes: 108_049_351,
      ...WINDOWS_FILES(65_130_848, 146_707_096),
    },
    "win32-x64": {
      url: `${RELEASES_URL}/windows/agy-acp-server-1.5.2-windows-x86_64.zip`,
      sha256: "5cbadd4f4df698572473d8890fc26ec2dc1724501f06e3a963941daec2bd21d6",
      archiveBytes: 105_407_645,
      ...WINDOWS_FILES(58_368_800, 155_357_336),
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
