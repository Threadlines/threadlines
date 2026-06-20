import { compareSemverVersions, parseSemver } from "@threadlines/shared/semver";
import { CancellationToken, type UpdateInfo } from "electron-updater";
import type { AppUpdater } from "electron-updater/out/AppUpdater.js";
import { BaseGitHubProvider } from "electron-updater/out/providers/GitHubProvider.js";
import {
  getFileList,
  parseUpdateInfo,
  type ProviderRuntimeOptions,
} from "electron-updater/out/providers/Provider.js";
import type { ResolvedUpdateFileInfo } from "electron-updater/out/types.js";
import { getChannelFilename } from "electron-updater/out/util.js";

type PrivateGitHubRequestHeaders = Record<string, string | number | Array<string> | undefined>;

interface PrivateGitHubUpdateAsset {
  readonly name: string;
  readonly url: string;
}

export interface PrivateGitHubUpdateRelease {
  readonly tag_name: string;
  readonly name?: string | null;
  readonly html_url?: string | null;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly created_at?: string | null;
  readonly published_at?: string | null;
  readonly assets: ReadonlyArray<PrivateGitHubUpdateAsset>;
}

interface PrivateGitHubUpdateInfo extends UpdateInfo {
  readonly assets: ReadonlyArray<PrivateGitHubUpdateAsset>;
}

export interface SortedPrivateGitHubProviderOptions {
  readonly provider: "custom";
  readonly owner: string;
  readonly repo: string;
  readonly private: true;
  readonly token: string;
  readonly releaseType?: "draft" | "prerelease" | "release" | null;
  readonly channel?: string | null;
  readonly updateProvider?: typeof SortedPrivateGitHubProvider;
}

interface PrivateGitHubReleaseSelectionInput {
  readonly releases: ReadonlyArray<PrivateGitHubUpdateRelease>;
  readonly channel?: string | null | undefined;
  readonly releaseType?: "draft" | "prerelease" | "release" | null | undefined;
  readonly channelFile: string;
}

function normalizeReleaseVersion(tagName: string): string {
  return tagName.trim().replace(/^v/, "");
}

function isNightlyVersion(version: string): boolean {
  return parseSemver(version)?.prerelease[0] === "nightly";
}

function releaseTimestamp(release: PrivateGitHubUpdateRelease): number {
  const timestamp = Date.parse(release.published_at ?? release.created_at ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function releaseHasAsset(release: PrivateGitHubUpdateRelease, assetName: string): boolean {
  return release.assets.some((asset) => asset.name === assetName);
}

function makeUpdaterError(message: string, code: string): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

function getPosixBasename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function shouldUseNightlyChannel(channel: string | null | undefined): boolean {
  return channel?.trim().toLowerCase() === "nightly";
}

function shouldUsePrereleaseChannel(input: {
  readonly channel?: string | null | undefined;
  readonly releaseType?: "draft" | "prerelease" | "release" | null | undefined;
}): boolean {
  return shouldUseNightlyChannel(input.channel) || input.releaseType === "prerelease";
}

export function selectPrivateGitHubUpdateRelease(
  input: PrivateGitHubReleaseSelectionInput,
): PrivateGitHubUpdateRelease | undefined {
  const useNightly = shouldUseNightlyChannel(input.channel);
  const usePrerelease = shouldUsePrereleaseChannel(input);

  return input.releases
    .map((release) => ({
      release,
      version: normalizeReleaseVersion(release.tag_name),
    }))
    .filter(({ release, version }) => {
      if (release.draft) return false;
      if (!parseSemver(version)) return false;
      if (!releaseHasAsset(release, input.channelFile)) return false;
      if (useNightly) return release.prerelease && isNightlyVersion(version);
      if (usePrerelease) return release.prerelease;
      return !release.prerelease;
    })
    .toSorted((left, right) => {
      const versionComparison = compareSemverVersions(right.version, left.version);
      if (versionComparison !== 0) return versionComparison;
      return releaseTimestamp(right.release) - releaseTimestamp(left.release);
    })[0]?.release;
}

function normalizePrivateGitHubRelease(value: unknown): PrivateGitHubUpdateRelease | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.tag_name !== "string") return undefined;
  if (!Array.isArray(record.assets)) return undefined;

  const assets = record.assets.flatMap((asset): ReadonlyArray<PrivateGitHubUpdateAsset> => {
    if (typeof asset !== "object" || asset === null) return [];
    const assetRecord = asset as Record<string, unknown>;
    if (typeof assetRecord.name !== "string" || typeof assetRecord.url !== "string") return [];
    return [{ name: assetRecord.name, url: assetRecord.url }];
  });

  return {
    tag_name: record.tag_name,
    name: typeof record.name === "string" ? record.name : null,
    html_url: typeof record.html_url === "string" ? record.html_url : null,
    draft: record.draft === true,
    prerelease: record.prerelease === true,
    created_at: typeof record.created_at === "string" ? record.created_at : null,
    published_at: typeof record.published_at === "string" ? record.published_at : null,
    assets,
  };
}

function parsePrivateGitHubReleases(raw: string | null): ReadonlyArray<PrivateGitHubUpdateRelease> {
  const parsed = JSON.parse(raw ?? "[]") as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const release = normalizePrivateGitHubRelease(entry);
    return release ? [release] : [];
  });
}

export class SortedPrivateGitHubProvider extends BaseGitHubProvider<PrivateGitHubUpdateInfo> {
  private readonly token: string;

  constructor(
    options: SortedPrivateGitHubProviderOptions,
    _updater: AppUpdater,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    super({ ...options, provider: "github" } as never, "github.com", runtimeOptions);
    this.token = options.token;
  }

  protected override createRequestOptions(url: URL, headers?: PrivateGitHubRequestHeaders | null) {
    const result = super.createRequestOptions(url, headers);
    (result as typeof result & { redirect: string }).redirect = "manual";
    return result;
  }

  override get fileExtraDownloadHeaders(): PrivateGitHubRequestHeaders | null {
    return this.configureHeaders("application/octet-stream");
  }

  override async getLatestVersion(): Promise<PrivateGitHubUpdateInfo> {
    const cancellationToken = new CancellationToken();
    const channelFile = this.resolveChannelFile();
    const releaseInfo = await this.getLatestVersionInfo(channelFile, cancellationToken);
    const asset = releaseInfo.assets.find((candidate) => candidate.name === channelFile);
    if (!asset) {
      throw makeUpdaterError(
        `Cannot find ${channelFile} in the release ${releaseInfo.html_url || releaseInfo.name}`,
        "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
      );
    }

    const channelFileUrl = new URL(asset.url);
    const rawUpdateInfo = await this.httpRequest(
      channelFileUrl,
      this.configureHeaders("application/octet-stream"),
      cancellationToken,
    );
    return {
      ...parseUpdateInfo(rawUpdateInfo, channelFile, channelFileUrl),
      assets: releaseInfo.assets,
    };
  }

  override resolveFiles(updateInfo: PrivateGitHubUpdateInfo): Array<ResolvedUpdateFileInfo> {
    return getFileList(updateInfo).map((file) => {
      const name = getPosixBasename(file.url).replace(/ /g, "-");
      const asset = updateInfo.assets.find((candidate) => candidate.name === name);
      if (!asset) {
        throw makeUpdaterError(
          `Cannot find asset "${name}" in: ${JSON.stringify(updateInfo.assets, null, 2)}`,
          "ERR_UPDATER_ASSET_NOT_FOUND",
        );
      }
      return {
        url: new URL(asset.url),
        info: file,
      };
    });
  }

  private resolveChannelFile(): string {
    const channel = this.options.channel?.trim();
    const channelName = channel ? this.getCustomChannelName(channel) : this.getDefaultChannelName();
    return getChannelFilename(channelName);
  }

  private configureHeaders(accept: string): PrivateGitHubRequestHeaders {
    return {
      accept,
      authorization: `token ${this.token}`,
    };
  }

  private async getLatestVersionInfo(
    channelFile: string,
    cancellationToken: CancellationToken,
  ): Promise<PrivateGitHubUpdateRelease> {
    const releasesUrl = new URL(this.computeGithubBasePath(this.basePath), this.baseApiUrl);
    try {
      const releases = parsePrivateGitHubReleases(
        await this.httpRequest(
          releasesUrl,
          this.configureHeaders("application/vnd.github.v3+json"),
          cancellationToken,
        ),
      );
      const release = selectPrivateGitHubUpdateRelease({
        releases,
        channel: this.options.channel,
        releaseType: this.options.releaseType,
        channelFile,
      });
      if (release) return release;
    } catch (error) {
      throw makeUpdaterError(
        `Unable to find latest version on GitHub (${releasesUrl}), please ensure a matching release exists: ${
          error instanceof Error ? error.stack || error.message : String(error)
        }`,
        "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
      );
    }

    throw makeUpdaterError(
      `Unable to find a published ${this.options.channel ?? "stable"} release with ${channelFile} in ${
        this.options.owner
      }/${this.options.repo}.`,
      "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
    );
  }

  private get basePath(): string {
    return `/repos/${this.options.owner}/${this.options.repo}/releases`;
  }
}
