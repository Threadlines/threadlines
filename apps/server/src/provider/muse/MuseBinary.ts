/**
 * MuseBinary — where the `muse` program is, its version, and how to install
 * and update it.
 *
 * Meta's installer puts a small launcher at `~/.local/bin/muse` (Windows:
 * `%LOCALAPPDATA%\Programs\muse\muse.cmd`) and edits the shell profile; the
 * launcher runs the versioned binary next to it and keeps it up to date. A
 * server started before the install never reads that profile, so a bare
 * `muse` is looked up on PATH first and in the installer's folder second, at
 * the moment it runs: a one-click install works without a restart.
 *
 * Meta's terms forbid redistributing the binary, so Threadlines never bundles
 * it: Install runs Meta's own installer.
 *
 * @module provider/muse/MuseBinary
 */
// @effect-diagnostics nodeBuiltinImport:off
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ProviderDriverKind, type ServerProviderDetection } from "@threadlines/contracts";
import { compareSemverVersions } from "@threadlines/shared/semver";
import { resolveCommandPath } from "@threadlines/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { detectProviderBinary, withKnownCliDirsOnPath } from "../providerDetection.ts";
import {
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCommandAction,
} from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("muse");

/**
 * The oldest Muse Code this driver runs: 1.4.8 picks the permission profile
 * on resume, streams the model's narration and reports whether the sandbox
 * works.
 */
export const MINIMUM_MUSE_VERSION = "1.4.8";

export const MUSE_INSTALL_COMMAND = "curl -fsSL https://dev.meta.ai/install.sh | bash";
/**
 * Windows PowerShell (5.1) explicitly: Meta's script breaks under
 * PowerShell 7 (muse-code-sdk #68).
 */
export const MUSE_WINDOWS_INSTALL_COMMAND =
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://dev.meta.ai/install.ps1 | iex"';

/** The launcher's own synchronous update: it refreshes the binary, then prints the version. */
export const MUSE_LAUNCHER_UPDATE_ENV = {
  MUSE_NO_AUTO_UPDATE: "0",
  MUSE_SYNC_UPDATE: "1",
  MUSE_UPDATE_INTERVAL_SECONDS: "0",
} as const;

function homeOf(env: NodeJS.ProcessEnv): string | undefined {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || undefined;
}

/** Where Meta's installer puts the launcher. */
export function museInstallerBinary(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    return localAppData ? join(localAppData, "Programs", "muse", "muse.cmd") : undefined;
  }
  const installDir = env.MUSE_INSTALL_DIR?.trim();
  const home = homeOf(env);
  if (installDir) return join(installDir, "muse");
  return home ? join(home, ".local", "bin", "muse") : undefined;
}

function installerFallback(name: string, env: NodeJS.ProcessEnv): string | undefined {
  if (name !== "muse") return undefined;
  const candidate = museInstallerBinary(env);
  return candidate && existsSync(candidate) ? candidate : undefined;
}

/** The binary to run for a configured `binaryPath` (a bare name or a path). */
export function resolveMuseBinary(binaryPath: string, env: NodeJS.ProcessEnv): string {
  const trimmed = binaryPath.trim() || "muse";
  if (/[\\/]/u.test(trimmed)) return trimmed;
  return (
    resolveCommandPath(trimmed, { platform: process.platform, env: withKnownCliDirsOnPath(env) }) ??
    installerFallback(trimmed, env) ??
    trimmed
  );
}

/** Whether the binary is on disk where `resolveMuseBinary` looks; reads the filesystem only. */
export function detectMuseBinary(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
): ServerProviderDetection {
  return detectProviderBinary({
    binaryPath: binaryPath.trim() || "muse",
    env,
    knownCliDirs: true,
    fallback: (name) => installerFallback(name, env),
  });
}

/**
 * `Muse Code 1.4.9 (1.4.9-R6297.1)` → `1.4.9`. The release revision is left
 * out: updates are judged by release.
 */
export function parseMuseVersion(output: string): string | null {
  const match = /\b(\d+\.\d+\.\d+)(?:-R\d+(?:\.\d+)?)?\b/u.exec(output);
  return match ? match[1]! : null;
}

export function isSupportedMuseVersion(version: string): boolean {
  return compareSemverVersions(version, MINIMUM_MUSE_VERSION) >= 0;
}

/** Whether a file's text is Meta's launcher script (it owns its own update). */
export function isMuseLauncherScript(source: string): boolean {
  return source.includes("muse-code/launcher-") && source.includes("MUSE_SYNC_UPDATE");
}

function isHomebrewCask(realCommandPath: string): boolean {
  return normalizeCommandPath(realCommandPath).includes("/caskroom/muse-code/");
}

function installAction(platform: NodeJS.Platform): ProviderMaintenanceCommandAction {
  return platform === "win32"
    ? {
        command: MUSE_WINDOWS_INSTALL_COMMAND,
        executable: "powershell.exe",
        args: [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "irm https://dev.meta.ai/install.ps1 | iex",
        ],
        lockKey: "muse-install",
      }
    : {
        command: MUSE_INSTALL_COMMAND,
        executable: "bash",
        args: ["-c", MUSE_INSTALL_COMMAND],
        lockKey: "muse-install",
      };
}

/**
 * Install: Meta's installer (bash on macOS and Linux, Windows PowerShell on
 * Windows). Update: the launcher's own synchronous update when the binary is
 * Meta's launcher, `brew upgrade --cask muse-code` for the Homebrew cask, and
 * the installer again on Windows (its launcher is not a script Threadlines
 * can drive). Anything else updates by hand.
 */
export function museMaintenanceCapabilities(input: {
  /** The binary Threadlines runs. */
  readonly commandPath: string;
  /** `commandPath` with links resolved. */
  readonly realCommandPath: string;
  /** The binary is Meta's launcher script. */
  readonly isLauncher: boolean;
  /** The binary was found at all. */
  readonly installed: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): ProviderMaintenanceCapabilities {
  const platform = input.platform ?? process.platform;
  const install = installAction(platform);
  const channel = input.env.MUSE_CHANNEL?.trim();
  const channelPatch = channel ? { MUSE_CHANNEL: channel } : {};
  if (!input.installed) {
    return makeProviderMaintenanceCapabilities({
      provider: DRIVER_KIND,
      packageName: null,
      updateExecutable: null,
      updateArgs: [],
      updateLockKey: null,
      install,
    });
  }
  if (platform === "win32") {
    return makeProviderMaintenanceCapabilities({
      provider: DRIVER_KIND,
      packageName: null,
      updateExecutable: install.executable,
      updateArgs: install.args,
      updateLockKey: "muse-install",
      updateDisplayCommand: install.command,
      install,
    });
  }
  if (isHomebrewCask(input.realCommandPath)) {
    return makeProviderMaintenanceCapabilities({
      provider: DRIVER_KIND,
      packageName: null,
      updateExecutable: "brew",
      updateArgs: ["upgrade", "--cask", "muse-code"],
      updateLockKey: "homebrew",
      install,
    });
  }
  if (input.isLauncher) {
    return makeProviderMaintenanceCapabilities({
      provider: DRIVER_KIND,
      packageName: null,
      updateExecutable: input.commandPath,
      updateArgs: ["--version"],
      updateLockKey: "muse-launcher",
      updateDisplayCommand: [
        ...Object.entries({ ...channelPatch, ...MUSE_LAUNCHER_UPDATE_ENV }).map(
          ([name, value]) => `${name}=${value}`,
        ),
        input.commandPath,
        "--version",
      ].join(" "),
      updateEnvironmentPatch: { ...channelPatch, ...MUSE_LAUNCHER_UPDATE_ENV },
      install,
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
    updateExecutable: null,
    updateArgs: [],
    updateLockKey: null,
    install,
    manualUpdateCommand: MUSE_INSTALL_COMMAND,
  });
}

const ChannelManifest = Schema.Struct({ version: Schema.String });
const LATEST_TTL_MS = 60 * 60 * 1_000;
const latestCache = new Map<
  string,
  { readonly expiresAt: number; readonly version: string | null }
>();

/** The newest release on the user's channel (`muse-stable` unless `MUSE_CHANNEL` says otherwise). */
export const fetchLatestMuseVersion = Effect.fn("fetchLatestMuseVersion")(function* (
  env: NodeJS.ProcessEnv,
) {
  const channel = env.MUSE_CHANNEL?.trim() || "muse-stable";
  if (channel !== "muse-stable" && channel !== "muse-canary") return null;
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const cached = latestCache.get(channel);
  if (cached && cached.expiresAt > now) return cached.version;
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.get(`https://api.meta.ai/muse-code/channels/${channel}`).pipe(
        HttpClientRequest.setHeader("accept", "application/json"),
      ),
    )
    .pipe(
      Effect.timeoutOption(4_000),
      Effect.catch(() => Effect.succeed(Option.none())),
    );
  let version: string | null = null;
  if (Option.isSome(response) && response.value.status >= 200 && response.value.status < 300) {
    const manifest = yield* response.value.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ChannelManifest)),
      Effect.catch(() => Effect.succeed(null)),
    );
    version = manifest ? parseMuseVersion(manifest.version) : null;
  }
  latestCache.set(channel, { expiresAt: now + LATEST_TTL_MS, version });
  return version;
});
