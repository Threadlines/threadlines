import type {
  SourceControlProviderDiscoveryItem,
  SourceControlToolUpdateTarget,
  SourceControlToolVersionAdvisory,
  VcsDiscoveryItem,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  gitForWindowsUpdateRecipe,
  sourceControlToolLabel,
  sourceControlToolPackageRecipe,
  TOOL_RELEASE_URLS,
  type SourceControlToolPackageManager,
} from "./SourceControlToolPackages.ts";
import type { LatestWinGetVersionResolver } from "./SourceControlWinGet.ts";

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

function windowsUpdateActions(input: {
  readonly target: SourceControlToolUpdateTarget;
  readonly currentVersion: string | null;
  readonly winGetVersion: string | null;
  readonly canRunUpdate: boolean;
  readonly copyCommand: string;
  readonly openLabel: string;
  readonly openUrl: string;
}): SourceControlToolVersionAdvisory["actions"] {
  const winGetUpdateAvailable =
    input.currentVersion !== null &&
    input.winGetVersion !== null &&
    compareToolVersions(input.currentVersion, input.winGetVersion) < 0;

  return [
    ...(input.canRunUpdate && winGetUpdateAvailable
      ? ([{ label: "Update now", kind: "runUpdate", target: input.target }] as const)
      : []),
    ...(winGetUpdateAvailable
      ? ([{ label: "Copy WinGet command", kind: "copyCommand", value: input.copyCommand }] as const)
      : []),
    { label: input.openLabel, kind: "openUrl", value: input.openUrl },
  ];
}

function gitForWindowsUpdateActions(input: {
  readonly canRunUpdate: boolean;
}): SourceControlToolVersionAdvisory["actions"] {
  const recipe = gitForWindowsUpdateRecipe();
  return [
    ...(input.canRunUpdate
      ? ([{ label: "Update now", kind: "runUpdate", target: "git" }] as const)
      : []),
    { label: recipe.copyLabel, kind: "copyCommand", value: recipe.copyCommand },
    { label: "Open official release", kind: "openUrl", value: GIT_FOR_WINDOWS_RELEASES_URL },
  ];
}

function installActions(input: {
  readonly target: SourceControlToolUpdateTarget;
  readonly packageManager: SourceControlToolPackageManager | null;
  readonly canRun: boolean;
  readonly openLabel: string;
  readonly openUrl: string;
}): SourceControlToolVersionAdvisory["actions"] {
  const recipe = input.packageManager
    ? sourceControlToolPackageRecipe({
        manager: input.packageManager,
        target: input.target,
        operation: "install",
      })
    : null;
  return [
    ...(recipe && input.canRun
      ? ([
          {
            label: "Install now",
            kind: "runUpdate",
            target: input.target,
            operation: "install",
          },
        ] as const)
      : []),
    ...(recipe
      ? ([{ label: recipe.copyLabel, kind: "copyCommand", value: recipe.copyCommand }] as const)
      : []),
    { label: input.openLabel, kind: "openUrl", value: input.openUrl },
  ];
}

function updateActions(input: {
  readonly target: SourceControlToolUpdateTarget;
  readonly packageManager: SourceControlToolPackageManager | null;
  readonly canRun: boolean;
  readonly openLabel: string;
  readonly openUrl: string;
}): SourceControlToolVersionAdvisory["actions"] {
  const recipe = input.packageManager
    ? sourceControlToolPackageRecipe({
        manager: input.packageManager,
        target: input.target,
        operation: "update",
      })
    : null;
  // `canRun` false here means the tool in use is not managed by the package
  // manager (e.g. a `gh` installed outside Homebrew), so the copy command
  // would fail exactly like the one-click run — neither is offered.
  return [
    ...(recipe && input.canRun
      ? ([
          {
            label: "Update now",
            kind: "runUpdate",
            target: input.target,
            operation: "update",
          },
          { label: recipe.copyLabel, kind: "copyCommand", value: recipe.copyCommand },
        ] as const)
      : []),
    { label: input.openLabel, kind: "openUrl", value: input.openUrl },
  ];
}

function sourceControlToolTargetForItem(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
): SourceControlToolUpdateTarget | null {
  if (!("auth" in item) && item.kind === "git") return "git";
  if ("auth" in item) {
    switch (item.kind) {
      case "github":
        return "github-cli";
      case "gitlab":
        return "gitlab-cli";
      case "azure-devops":
        return "azure-cli";
      case "bitbucket":
      case "unknown":
        return null;
    }
  }
  return null;
}

function createMissingToolAdvisory(input: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly packageManager: SourceControlToolPackageManager | null;
  readonly canRunInstall: boolean;
  readonly checkedAt: string;
}): SourceControlToolVersionAdvisory | undefined {
  const target = sourceControlToolTargetForItem(input.item);
  if (target === null) return undefined;

  const actions = installActions({
    target,
    packageManager: input.packageManager,
    canRun: input.canRunInstall,
    openLabel: "Open install guide",
    openUrl: TOOL_RELEASE_URLS[target],
  });

  return advisory({
    status: "install_available",
    severity: "info",
    currentVersion: null,
    latestVersion: null,
    recommendedVersion: null,
    checkedAt: input.checkedAt,
    message: `Install ${sourceControlToolLabel(target)} to enable this source control integration.`,
    notificationKey: null,
    actions,
  });
}

function winGetAvailabilityNote(input: {
  readonly label: string;
  readonly currentVersion: string | null;
  readonly targetVersion: string | null;
  readonly winGetVersion: string | null;
}): string | null {
  if (
    input.currentVersion === null ||
    input.targetVersion === null ||
    compareToolVersions(input.currentVersion, input.targetVersion) >= 0
  ) {
    return null;
  }

  if (input.winGetVersion === null) {
    return `Threadlines could not verify ${input.label} ${input.targetVersion} in WinGet; use the official release link or check again later.`;
  }
  if (compareToolVersions(input.winGetVersion, input.targetVersion) >= 0) {
    return null;
  }
  if (compareToolVersions(input.currentVersion, input.winGetVersion) < 0) {
    return `WinGet currently offers ${input.winGetVersion}, but ${input.label} ${input.targetVersion} has not reached WinGet yet.`;
  }
  return `${input.label} ${input.targetVersion} has not reached WinGet yet; use the official release link or check again later.`;
}

function createGitHubCliAdvisory(input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
  readonly winGetVersion: string | null;
  readonly platform: NodeJS.Platform;
  readonly checkedAt: string;
  readonly canRunUpdate: boolean;
  readonly packageManager: SourceControlToolPackageManager | null | undefined;
}): SourceControlToolVersionAdvisory | undefined {
  const actions: SourceControlToolVersionAdvisory["actions"] =
    input.platform === "win32"
      ? windowsUpdateActions({
          target: "github-cli",
          currentVersion: input.currentVersion,
          winGetVersion: input.winGetVersion,
          canRunUpdate: input.canRunUpdate,
          copyCommand:
            "winget upgrade --id GitHub.cli --exact --source winget --silent --accept-source-agreements --accept-package-agreements --disable-interactivity",
          openLabel: "Open releases",
          openUrl: GITHUB_CLI_RELEASES_URL,
        })
      : updateActions({
          target: "github-cli",
          packageManager: input.packageManager ?? null,
          canRun: input.canRunUpdate,
          openLabel: "Open releases",
          openUrl: GITHUB_CLI_RELEASES_URL,
        });

  // A Homebrew host whose gh did not come from Homebrew (its own installer,
  // a version manager) gets no update actions, so the message has to say why
  // and point at the path that does work.
  const outsideHomebrewNote =
    input.platform !== "win32" && input.packageManager === "homebrew" && !input.canRunUpdate
      ? "This GitHub CLI was not installed with Homebrew, so Threadlines cannot update it here. Update it with the tool that installed it, or use the release link."
      : null;

  if (
    input.currentVersion !== null &&
    compareToolVersions(input.currentVersion, GH_SECURITY_VERSION) < 0
  ) {
    const hasWindowsTerminalFlashRisk =
      input.platform === "win32" &&
      compareToolVersions(input.currentVersion, GH_TERMINAL_FLASH_FIXED_VERSION) < 0;
    const baseMessage = hasWindowsTerminalFlashRisk
      ? "This GitHub CLI version can briefly open terminal windows during background telemetry on Windows and is below the recommended security-fix release."
      : "This GitHub CLI version is below the recommended security-fix release.";
    const availabilityNote =
      input.platform === "win32"
        ? winGetAvailabilityNote({
            label: "GitHub CLI",
            currentVersion: input.currentVersion,
            targetVersion: GH_SECURITY_VERSION,
            winGetVersion: input.winGetVersion,
          })
        : outsideHomebrewNote;
    return advisory({
      status: "recommended_update",
      severity: "warning",
      currentVersion: input.currentVersion,
      latestVersion: input.latestVersion,
      recommendedVersion: GH_SECURITY_VERSION,
      checkedAt: input.checkedAt,
      message: availabilityNote ? `${baseMessage} ${availabilityNote}` : baseMessage,
      notificationKey: `github-cli:security:${GH_SECURITY_VERSION}`,
      actions,
    });
  }

  if (
    input.currentVersion !== null &&
    input.latestVersion !== null &&
    compareToolVersions(input.currentVersion, input.latestVersion) < 0
  ) {
    const availabilityNote =
      input.platform === "win32"
        ? winGetAvailabilityNote({
            label: "GitHub CLI",
            currentVersion: input.currentVersion,
            targetVersion: input.latestVersion,
            winGetVersion: input.winGetVersion,
          })
        : outsideHomebrewNote;
    return advisory({
      status: "behind_latest",
      severity: "info",
      currentVersion: input.currentVersion,
      latestVersion: input.latestVersion,
      recommendedVersion: input.latestVersion,
      checkedAt: input.checkedAt,
      message: availabilityNote ?? "A newer GitHub CLI version is available for this environment.",
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

  if (input.currentVersion !== null && !/\.windows\.\d+$/iu.test(input.currentVersion)) {
    return undefined;
  }

  const actions = gitForWindowsUpdateActions({ canRunUpdate: input.canRunUpdate });

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
      message:
        "This Git for Windows version is below the recommended security-fix release. The official updater may close open Git Bash windows during installation.",
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
      message:
        "A newer Git for Windows release is available. The official updater may close open Git Bash windows during installation.",
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
  readonly winGetVersionResolver?: LatestWinGetVersionResolver;
  readonly canRunUpdate?: boolean;
  readonly packageManager?: SourceControlToolPackageManager | null;
  readonly canRunInstall?: boolean;
}): Effect.Effect<Item> {
  const checkedAt = new Date().toISOString();

  if (input.item.status !== "available") {
    const versionAdvisory = createMissingToolAdvisory({
      item: input.item,
      packageManager: input.packageManager ?? null,
      canRunInstall: input.canRunInstall === true,
      checkedAt,
    });
    return Effect.succeed(
      versionAdvisory ? ({ ...input.item, versionAdvisory } as Item) : input.item,
    );
  }

  const resolver = input.latestVersionResolver;
  const versionLine = Option.getOrNull(input.item.version);

  if ("auth" in input.item && input.item.kind === "github") {
    const currentVersion = parseGitHubCliVersion(versionLine);
    return Effect.all({
      latestVersion: resolver("github-cli"),
      winGetVersion:
        input.platform === "win32" && input.winGetVersionResolver
          ? input.winGetVersionResolver("github-cli")
          : Effect.succeed(null),
    }).pipe(
      Effect.map(({ latestVersion, winGetVersion }) => {
        const versionAdvisory = createGitHubCliAdvisory({
          currentVersion,
          latestVersion,
          winGetVersion,
          platform: input.platform,
          checkedAt,
          canRunUpdate: input.canRunUpdate === true,
          packageManager: input.packageManager,
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
