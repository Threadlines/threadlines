const REPO = "Threadlines/threadlines";

export const RELEASES_URL = `https://github.com/${REPO}/releases`;

const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const LIST_URL = `https://api.github.com/repos/${REPO}/releases?per_page=1`;
const CACHE_KEY = "threadlines-latest-release-v2";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

function isRelease(value: unknown): value is Release {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Release).assets) &&
    typeof (value as Release).tag_name === "string"
  );
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  return response.json();
}

export async function fetchLatestRelease(): Promise<Release> {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) {
    const parsed: unknown = JSON.parse(cached);
    if (isRelease(parsed)) return parsed;
  }

  // /releases/latest only knows stable releases; fall back to the newest
  // release of any kind (nightlies are prereleases) when none exists yet.
  let data: unknown;
  try {
    data = await fetchJson(LATEST_URL);
  } catch {
    const list = await fetchJson(LIST_URL);
    data = Array.isArray(list) ? list[0] : undefined;
  }

  if (!isRelease(data)) throw new Error("No release available");

  sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
  return data;
}

export interface InstallerSet {
  macArm?: ReleaseAsset;
  macX64?: ReleaseAsset;
  winX64?: ReleaseAsset;
  winArm?: ReleaseAsset;
  linuxX64?: ReleaseAsset;
}

export function classifyAssets(assets: ReadonlyArray<ReleaseAsset>): InstallerSet {
  const set: InstallerSet = {};
  for (const asset of assets) {
    const name = asset.name.toLowerCase();
    if (name.endsWith(".dmg")) {
      if (name.includes("arm64")) set.macArm ??= asset;
      else if (name.includes("x64") || name.includes("x86_64")) set.macX64 ??= asset;
    } else if (name.endsWith(".exe") && !name.includes("blockmap")) {
      if (name.includes("arm64")) set.winArm ??= asset;
      else if (name.includes("x64")) set.winX64 ??= asset;
    } else if (name.endsWith(".appimage")) {
      if (name.includes("x86_64") || name.includes("x64")) set.linuxX64 ??= asset;
    }
  }
  return set;
}

export function formatAssetSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}
