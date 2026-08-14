import type {
  SourceControlProviderDiscoveryItem,
  SourceControlToolVersionAdvisory,
  VcsDiscoveryItem,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const LATEST_VERSION_TIMEOUT_MS = 5_000;
const LATEST_VERSION_CACHE_TTL_MS = 12 * 60 * 60_000;
const LATEST_VERSION_FAILURE_CACHE_TTL_MS = 30 * 60_000;

// v2.93.0 first shipped cli/cli#13353, which suppresses the Windows tzutil console flash.
const GH_TERMINAL_FLASH_FIXED_VERSION = "2.93.0";
// v2.97.0 fixed four upstream security advisories and explicitly asked users to update promptly.
const GH_SECURITY_VERSION = "2.97.0";
// v2.55.0.windows.4 is the Git for Windows CVE-2026-62960 security-fix release.
const GIT_FOR_WINDOWS_SECURITY_VERSION = "2.55.0.windows.4";

const GITHUB_CLI_RELEASES_URL = "https://github.com/cli/cli/releases/latest";
const GIT_FOR_WINDOWS_RELEASES_URL = "https://github.com/git-for-windows/git/releases/latest";

type SourceControlToolVersionTarget = "github-cli" | "git-for-windows";

export type LatestVersionResolver = (
  target: SourceControlToolVersionTarget,
) => Effect.Effect<string | null>;

interface CachedLatestVersion {
  readonly expiresAt: number;
  readonly version: string | null;
}

const latestVersionCache = new Map<SourceControlToolVersionTarget, CachedLatestVersion>();

export function clearSourceControlToolVersionAdvisoryCacheForTests(): void {
  latestVersionCache.clear();
}

const LatestGitHubReleaseResponse = Schema.Struct({
  tag_name: Schema.String,
});

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function stripVersionPrefix(value: string): string {
  return value.trim().replace(/^v/iu, "");
}

export function parseGitHubCliVersion(versionLine: string | null): string | null {
  const value = nonEmpty(versionLine);
  if (!value) return null;
  return nonEmpty(value.match(/\bgh\s+version\s+([^\s]+)/iu)?.[1]);
}

export function parseGitVersion(versionLine: string | null): string | null {
  const value = nonEmpty(versionLine);
  if (!value) return null;
  return nonEmpty(value.match(/\bgit\s+version\s+([^\s]+)/iu)?.[1]);
}

function parseVersionSegments(value: string): ReadonlyArray<number | string> {
  return stripVersionPrefix(value)
    .split(/[\s.+_-]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => (/^\d+$/u.test(segment) ? Number.parseInt(segment, 10) : segment));
}

export function compareToolVersions(left: string, right: string): number {
  const leftSegments = parseVersionSegments(left);
  const rightSegments = parseVersionSegments(right);
  const length = Math.max(leftSegments.length, rightSegments.length);

  for (let index = 0; index < length; index += 1) {
    const leftSegment = leftSegments[index] ?? 0;
    const rightSegment = rightSegments[index] ?? 0;
    if (leftSegment === rightSegment) continue;

    if (typeof leftSegment === "number" && typeof rightSegment === "number") {
      return leftSegment - rightSegment;
    }
    if (typeof leftSegment === "number") return 1;
    if (typeof rightSegment === "number") return -1;

    const comparison = leftSegment.localeCompare(rightSegment);
    if (comparison !== 0) return comparison;
  }

  return 0;
}

function githubLatestReleaseApiUrl(target: SourceControlToolVersionTarget): string {
  switch (target) {
    case "github-cli":
      return "https://api.github.com/repos/cli/cli/releases/latest";
    case "git-for-windows":
      return "https://api.github.com/repos/git-for-windows/git/releases/latest";
  }
}

export const resolveLatestToolVersion = Effect.fn("resolveLatestSourceControlToolVersion")(
  function* (target: SourceControlToolVersionTarget) {
    const now = Date.now();
    const cached = latestVersionCache.get(target);
    if (cached && cached.expiresAt > now) {
      return cached.version;
    }

    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(githubLatestReleaseApiUrl(target)).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/vnd.github+json",
        "user-agent": "threadlines-source-control-advisory",
      }),
    );
    const response = yield* client.execute(request).pipe(
      Effect.timeoutOption(LATEST_VERSION_TIMEOUT_MS),
      Effect.catch(() => Effect.succeed(Option.none())),
    );

    if (Option.isNone(response) || response.value.status < 200 || response.value.status >= 300) {
      latestVersionCache.set(target, {
        expiresAt: now + LATEST_VERSION_FAILURE_CACHE_TTL_MS,
        version: null,
      });
      return null;
    }

    const payload = yield* response.value.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(LatestGitHubReleaseResponse)),
      Effect.catch(() => Effect.succeed(null)),
    );
    const version = payload ? nonEmpty(stripVersionPrefix(payload.tag_name)) : null;
    latestVersionCache.set(target, {
      expiresAt:
        now +
        (version === null ? LATEST_VERSION_FAILURE_CACHE_TTL_MS : LATEST_VERSION_CACHE_TTL_MS),
      version,
    });
    return version;
  },
);

function advisory(input: {
  readonly status: SourceControlToolVersionAdvisory["status"];
  readonly severity: SourceControlToolVersionAdvisory["severity"];
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
  readonly recommendedVersion: string | null;
  readonly checkedAt: string | null;
  readonly message: string | null;
  readonly notificationKey: string | null;
  readonly actions: SourceControlToolVersionAdvisory["actions"];
}): SourceControlToolVersionAdvisory {
  return {
    status: input.status,
    severity: input.severity,
    currentVersion: input.currentVersion,
    latestVersion: input.latestVersion,
    recommendedVersion: input.recommendedVersion,
    checkedAt: input.checkedAt,
    message: input.message,
    notificationKey: input.notificationKey,
    actions: input.actions,
  };
}

function createGitHubCliAdvisory(input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
  readonly platform: NodeJS.Platform;
  readonly checkedAt: string;
  readonly canRunUpdate: boolean;
}): SourceControlToolVersionAdvisory | undefined {
  const actions: SourceControlToolVersionAdvisory["actions"] =
    input.platform === "win32"
      ? [
          ...(input.canRunUpdate
            ? ([
                {
                  label: "Update now",
                  kind: "runUpdate",
                  target: "github-cli",
                },
              ] as const)
            : []),
          {
            label: "Copy WinGet command",
            kind: "copyCommand",
            value:
              "winget upgrade --id GitHub.cli --exact --source winget --silent --accept-source-agreements --accept-package-agreements --disable-interactivity",
          },
          { label: "Open releases", kind: "openUrl", value: GITHUB_CLI_RELEASES_URL },
        ]
      : input.platform === "darwin"
        ? [
            { label: "Copy Homebrew command", kind: "copyCommand", value: "brew upgrade gh" },
            { label: "Open releases", kind: "openUrl", value: GITHUB_CLI_RELEASES_URL },
          ]
        : [{ label: "Open update instructions", kind: "openUrl", value: GITHUB_CLI_RELEASES_URL }];

  if (
    input.currentVersion !== null &&
    compareToolVersions(input.currentVersion, GH_SECURITY_VERSION) < 0
  ) {
    const hasWindowsTerminalFlashRisk =
      input.platform === "win32" &&
      compareToolVersions(input.currentVersion, GH_TERMINAL_FLASH_FIXED_VERSION) < 0;
    return advisory({
      status: "recommended_update",
      severity: "warning",
      currentVersion: input.currentVersion,
      latestVersion: input.latestVersion,
      recommendedVersion: GH_SECURITY_VERSION,
      checkedAt: input.checkedAt,
      message: hasWindowsTerminalFlashRisk
        ? "This GitHub CLI version can briefly open terminal windows during background telemetry on Windows and is below the recommended security-fix release."
        : "This GitHub CLI version is below the recommended security-fix release.",
      notificationKey: `github-cli:security:${GH_SECURITY_VERSION}`,
      actions,
    });
  }

  if (
    input.currentVersion !== null &&
    input.latestVersion !== null &&
    compareToolVersions(input.currentVersion, input.latestVersion) < 0
  ) {
    return advisory({
      status: "behind_latest",
      severity: "info",
      currentVersion: input.currentVersion,
      latestVersion: input.latestVersion,
      recommendedVersion: input.latestVersion,
      checkedAt: input.checkedAt,
      message: "A newer GitHub CLI version is available for this environment.",
      notificationKey: null,
      actions,
    });
  }

  if (input.currentVersion !== null && input.latestVersion !== null) {
    return advisory({
      status: "current",
      severity: "info",
      currentVersion: input.currentVersion,
      latestVersion: input.latestVersion,
      recommendedVersion: null,
      checkedAt: input.checkedAt,
      message: null,
      notificationKey: null,
      actions: [],
    });
  }

  return undefined;
}

function createGitForWindowsAdvisory(input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
  readonly platform: NodeJS.Platform;
  readonly checkedAt: string;
  readonly canRunUpdate: boolean;
}): SourceControlToolVersionAdvisory | undefined {
  if (input.platform !== "win32") {
    return undefined;
  }

  const actions: SourceControlToolVersionAdvisory["actions"] = [
    ...(input.canRunUpdate
      ? ([
          {
            label: "Update now",
            kind: "runUpdate",
            target: "git",
          },
        ] as const)
      : []),
    {
      label: "Copy WinGet command",
      kind: "copyCommand",
      value:
        "winget upgrade --id Git.Git --exact --source winget --silent --accept-source-agreements --accept-package-agreements --disable-interactivity",
    },
    { label: "Open official release", kind: "openUrl", value: GIT_FOR_WINDOWS_RELEASES_URL },
  ];

  if (
    input.currentVersion !== null &&
    compareToolVersions(input.currentVersion, GIT_FOR_WINDOWS_SECURITY_VERSION) < 0
  ) {
    return advisory({
      status: "recommended_update",
      severity: "warning",
      currentVersion: input.currentVersion,
      latestVersion: input.latestVersion,
      recommendedVersion: GIT_FOR_WINDOWS_SECURITY_VERSION,
      checkedAt: input.checkedAt,
      message: "This Git for Windows version is below the recommended security-fix release.",
      notificationKey: `git-for-windows:security:${GIT_FOR_WINDOWS_SECURITY_VERSION}`,
      actions,
    });
  }

  if (
    input.currentVersion !== null &&
    input.latestVersion !== null &&
    compareToolVersions(input.currentVersion, input.latestVersion) < 0
  ) {
    return advisory({
      status: "behind_latest",
      severity: "info",
      currentVersion: input.currentVersion,
      latestVersion: input.latestVersion,
      recommendedVersion: input.latestVersion,
      checkedAt: input.checkedAt,
      message: "A newer Git for Windows release is available.",
      notificationKey: null,
      actions,
    });
  }

  if (input.currentVersion !== null && input.latestVersion !== null) {
    return advisory({
      status: "current",
      severity: "info",
      currentVersion: input.currentVersion,
      latestVersion: input.latestVersion,
      recommendedVersion: null,
      checkedAt: input.checkedAt,
      message: null,
      notificationKey: null,
      actions: [],
    });
  }

  return undefined;
}

export function withSourceControlToolVersionAdvisory<
  Item extends VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
>(input: {
  readonly item: Item;
  readonly platform: NodeJS.Platform;
  readonly latestVersionResolver: LatestVersionResolver;
  readonly canRunUpdate?: boolean;
}): Effect.Effect<Item> {
  if (input.item.status !== "available") {
    return Effect.succeed(input.item);
  }

  const resolver = input.latestVersionResolver;
  const versionLine = Option.getOrNull(input.item.version);
  const checkedAt = new Date().toISOString();

  if ("auth" in input.item && input.item.kind === "github") {
    const currentVersion = parseGitHubCliVersion(versionLine);
    return resolver("github-cli").pipe(
      Effect.map((latestVersion) => {
        const versionAdvisory = createGitHubCliAdvisory({
          currentVersion,
          latestVersion,
          platform: input.platform,
          checkedAt,
          canRunUpdate: input.canRunUpdate === true,
        });
        return versionAdvisory ? ({ ...input.item, versionAdvisory } as Item) : input.item;
      }),
      Effect.catch(() => Effect.succeed(input.item)),
    );
  }

  if (!("auth" in input.item) && input.item.kind === "git") {
    if (input.platform !== "win32") {
      return Effect.succeed(input.item);
    }

    const currentVersion = parseGitVersion(versionLine);
    return resolver("git-for-windows").pipe(
      Effect.map((latestVersion) => {
        const versionAdvisory = createGitForWindowsAdvisory({
          currentVersion,
          latestVersion,
          platform: input.platform,
          checkedAt,
          canRunUpdate: input.canRunUpdate === true,
        });
        return versionAdvisory ? ({ ...input.item, versionAdvisory } as Item) : input.item;
      }),
      Effect.catch(() => Effect.succeed(input.item)),
    );
  }

  return Effect.succeed(input.item);
}
