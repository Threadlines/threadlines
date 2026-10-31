/**
 * ClaudeMaintenance — how each kind of Claude install is updated, and where
 * its newest version is published.
 *
 * A native install follows a release channel on Anthropic's download server
 * (`autoUpdatesChannel` in Claude's settings, `latest` by default), which
 * moves later than npm. The update and the version check both use that channel.
 *
 * @module provider/Drivers/ClaudeMaintenance
 */
import { ProviderDriverKind } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  makePackageManagedProviderMaintenanceResolver,
  makeWindowsNativeInstaller,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilityResolutionOptions,
} from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const DOWNLOAD_BASE_URL = "https://downloads.claude.ai/claude-code-releases";

export type ClaudeUpdateChannel = "latest" | "stable";

const decodeClaudeUserSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ autoUpdatesChannel: Schema.optional(Schema.Unknown) })),
);

/**
 * The channel saved in Claude's user settings. Anything missing, unreadable or
 * unknown means `latest`, as it does to Claude. Managed settings aren't read.
 */
export const readClaudeUpdateChannel = Effect.fn("readClaudeUpdateChannel")(function* (
  configDir: string,
): Effect.fn.Return<ClaudeUpdateChannel, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* fileSystem
    .readFileString(path.join(configDir, "settings.json"))
    .pipe(Effect.catch(() => Effect.succeed("")));
  const settings = decodeClaudeUserSettings(contents);
  return Option.isSome(settings) && settings.value.autoUpdatesChannel === "stable"
    ? "stable"
    : "latest";
});

export const claudeWindowsNativeUpdateScript = (channel: ClaudeUpdateChannel) => String.raw`
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not [Environment]::Is64BitProcess) {
    Write-Error "Claude Code does not support 32-bit Windows. Please use a 64-bit version of Windows."
    exit 1
}

function Test-NativeClaudePath([string]$Path) {
    $normalized = $Path.Replace("\", "/").ToLowerInvariant()
    return $normalized.EndsWith("/.local/bin/claude.exe") -or $normalized.Contains("/.local/share/claude/")
}

$downloadBaseUrl = "${DOWNLOAD_BASE_URL}"
$downloadDir = Join-Path $env:USERPROFILE ".claude\downloads"
$defaultInstallPath = Join-Path $env:USERPROFILE ".local\bin\claude.exe"
$platform = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "win32-arm64" } else { "win32-x64" }

New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null

$version = Invoke-RestMethod -Uri "$downloadBaseUrl/${channel}" -ErrorAction Stop
if ($version -notmatch "^\d+\.\d+\.\d+") {
    Write-Error "Failed to get a valid Claude Code version from downloads.claude.ai."
    exit 1
}

$manifest = Invoke-RestMethod -Uri "$downloadBaseUrl/$version/manifest.json" -ErrorAction Stop
$platformManifest = $manifest.platforms.$platform
if (-not $platformManifest -or -not $platformManifest.checksum) {
    Write-Error "Platform $platform not found in Claude Code manifest."
    exit 1
}

$downloadPath = Join-Path $downloadDir "claude-$version-$platform.exe"
try {
    Invoke-WebRequest -Uri "$downloadBaseUrl/$version/$platform/claude.exe" -OutFile $downloadPath -ErrorAction Stop
    $actualChecksum = (Get-FileHash -Path $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualChecksum -ne $platformManifest.checksum) {
        Write-Error "Claude Code checksum verification failed."
        exit 1
    }

    $command = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $installPath = if ($command -and $command.Source -and (Test-NativeClaudePath $command.Source)) {
        $command.Source
    } else {
        $defaultInstallPath
    }

    $installDir = Split-Path -Parent $installPath
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    $backupPath = Join-Path $downloadDir "claude-backup-$PID-$([guid]::NewGuid().ToString('N')).exe"
    $preservedExistingExecutable = Test-Path -LiteralPath $installPath
    if ($preservedExistingExecutable) {
        Copy-Item -LiteralPath $installPath -Destination $backupPath -Force
    }

    try {
        Move-Item -LiteralPath $downloadPath -Destination $installPath -Force

        $installedVersion = & $installPath --version
        if ($LASTEXITCODE -ne 0 -or $installedVersion -notmatch [regex]::Escape($version)) {
            throw "Claude Code was replaced, but version verification failed: $installedVersion"
        }

        if (Test-Path -LiteralPath $backupPath) {
            Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
        }
        Write-Output "Installed Claude Code $installedVersion at $installPath"
    } catch {
        $updateFailure = $_
        if ($preservedExistingExecutable -and (Test-Path -LiteralPath $backupPath)) {
            try {
                Copy-Item -LiteralPath $backupPath -Destination $installPath -Force
                Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
                Write-Warning "Claude update failed; restored the previous executable at $installPath."
            } catch {
                Write-Error "Claude update failed and Threadlines could not restore the previous executable. The backup remains at $backupPath."
                throw
            }
        } elseif (Test-Path -LiteralPath $installPath) {
            Remove-Item -LiteralPath $installPath -Force -ErrorAction SilentlyContinue
        }
        throw $updateFailure
    }
} finally {
    if (Test-Path -LiteralPath $downloadPath) {
        Remove-Item -LiteralPath $downloadPath -Force
    }
}
`;

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

function makeClaudeMaintenanceResolver(channel: ClaudeUpdateChannel) {
  const encodedUpdate = Buffer.from(claudeWindowsNativeUpdateScript(channel), "utf16le").toString(
    "base64",
  );
  return makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: "@anthropic-ai/claude-code",
    homebrewFormula: "claude-code",
    nativeInstall: {
      win32: makeWindowsNativeInstaller({
        url: "https://claude.ai/install.ps1",
        lockKey: "claude-native-verified-win32",
      }),
    },
    nativeUpdate: {
      executable: "claude",
      args: ["update"],
      lockKey: "claude-native",
      isCommandPath: isClaudeNativeCommandPath,
      latestVersionSource: { kind: "releasePointer", url: `${DOWNLOAD_BASE_URL}/${channel}` },
      platformUpdateOverrides: {
        win32: {
          executable: "powershell.exe",
          args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedUpdate],
          lockKey: "claude-native-verified-win32",
          displayCommand: `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedUpdate}`,
        },
      },
    },
  });
}

const CLAUDE_MAINTENANCE_RESOLVERS = {
  latest: makeClaudeMaintenanceResolver("latest"),
  stable: makeClaudeMaintenanceResolver("stable"),
};

/**
 * This install's update route. `configDir` is the main Claude folder: the
 * update runs with the server's environment, so an account folder's settings
 * don't reach it.
 */
export const resolveClaudeMaintenanceCapabilities = Effect.fn(
  "resolveClaudeMaintenanceCapabilities",
)(function* (
  configDir: string,
  options: Omit<ProviderMaintenanceCapabilityResolutionOptions, "realCommandPath">,
) {
  const channel = yield* readClaudeUpdateChannel(configDir);
  return yield* resolveProviderMaintenanceCapabilitiesEffect(
    CLAUDE_MAINTENANCE_RESOLVERS[channel],
    options,
  );
});
