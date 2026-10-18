/**
 * PiBinary — the user's own `pi`: where it is, its version, and how it
 * updates. Threadlines' own copy is `PiRuntime`'s.
 *
 * Pi installs three ways: its installer (a launcher in `<agent dir>/bin`,
 * linked into a folder on PATH), npm, or Nix. A server started before the
 * install never reads the shell profile the installer edited, so a bare `pi`
 * is looked up on PATH first and at the launcher second, each time it runs.
 *
 * `pi update --self` updates the installer's and npm's copies itself; a Nix
 * copy updates with Nix.
 *
 * @module provider/pi/PiBinary
 */
// @effect-diagnostics nodeBuiltinImport:off
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ProviderDriverKind, type ServerProviderDetection } from "@threadlines/contracts";
import { compareSemverVersions } from "@threadlines/shared/semver";
import { resolveCommandPath } from "@threadlines/shared/shell";

import { detectProviderBinary, withKnownCliDirsOnPath } from "../providerDetection.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const PI_DRIVER_KIND = ProviderDriverKind.make("pi");

/** Pi on npm: what Threadlines installs, and where the newest version is read. */
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/**
 * The oldest Pi this driver runs: 1.3.0 acks a prompt with what it did with
 * it, settles runs with `agent_settled`, and keeps extension hooks on
 * `--session` and `--fork`.
 */
export const MINIMUM_PI_VERSION = "1.3.0";

export const PI_INSTALL_PAGE = "https://pi.dev";

/** The default command name; any other value of the setting is the user's own choice. */
const DEFAULT_COMMAND = "pi";

/**
 * Pi's own folder (settings, sign-ins, sessions, extensions):
 * `PI_CODING_AGENT_DIR`, else `~/.pi/agent`.
 */
export function piAgentDir(env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(home, ".pi", "agent");
  if (configured === "~") return home;
  return configured.startsWith("~/") || configured.startsWith("~\\")
    ? join(home, configured.slice(2))
    : configured;
}

/** Where Pi's installer puts its launcher (macOS and Linux only). */
export function piInstallerLauncher(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return platform === "win32" ? undefined : join(piAgentDir(env), "bin", DEFAULT_COMMAND);
}

function installerFallback(name: string, env: NodeJS.ProcessEnv): string | undefined {
  if (name !== DEFAULT_COMMAND) return undefined;
  const candidate = piInstallerLauncher(env);
  return candidate && existsSync(candidate) ? candidate : undefined;
}

/** The setting as a command: blank means `pi`. */
export const piCommandSetting = (binaryPath: string) => binaryPath.trim() || DEFAULT_COMMAND;

/** Whether the setting is the default, so Threadlines' own copy may stand in for it. */
export const isDefaultPiCommand = (binaryPath: string) =>
  piCommandSetting(binaryPath) === DEFAULT_COMMAND;

/**
 * The user's Pi for a configured `binaryPath` (a bare name or a path), or
 * undefined when a bare name is found nowhere.
 */
export function findUserPi(binaryPath: string, env: NodeJS.ProcessEnv): string | undefined {
  const command = piCommandSetting(binaryPath);
  if (/[\\/]/u.test(command)) return command;
  return (
    resolveCommandPath(command, { platform: process.platform, env: withKnownCliDirsOnPath(env) }) ??
    installerFallback(command, env)
  );
}

/** Whether the user's Pi is on disk where `findUserPi` looks; reads the filesystem only. */
export function detectPiBinary(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
): ServerProviderDetection {
  return detectProviderBinary({
    binaryPath: piCommandSetting(binaryPath),
    env,
    knownCliDirs: true,
    fallback: (name) => installerFallback(name, env),
  });
}

/** `pi --version` prints the bare version: `1.3.0`. */
export function parsePiVersion(output: string): string | null {
  const match = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u.exec(output);
  return match ? match[1]! : null;
}

export function isSupportedPiVersion(version: string): boolean {
  return compareSemverVersions(version, MINIMUM_PI_VERSION) >= 0;
}

const isNixStorePath = (realCommandPath: string) =>
  normalizeCommandPath(realCommandPath).startsWith("/nix/store/");

/**
 * Updating the user's own Pi: `pi update --self`, which knows how it was
 * installed; Nix by hand. The package name lets the snapshot read the newest
 * version from npm.
 */
export function piUserMaintenance(input: {
  /** The program Threadlines runs. */
  readonly commandPath: string;
  /** `commandPath` with links resolved. */
  readonly realCommandPath: string;
}): ProviderMaintenanceCapabilities {
  if (isNixStorePath(input.realCommandPath)) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: PI_DRIVER_KIND,
      packageName: PI_PACKAGE_NAME,
      manualUpdateCommand: "nix profile upgrade pi",
      advisoryMessage: "Pi was installed with Nix. Update it with `nix profile upgrade pi`.",
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider: PI_DRIVER_KIND,
    packageName: PI_PACKAGE_NAME,
    updateExecutable: input.commandPath,
    updateArgs: ["update", "--self"],
    updateLockKey: "pi-update",
    updateDisplayCommand: "pi update --self",
  });
}

/**
 * Names that hold a model provider's key for Pi (`ANTHROPIC_API_KEY`,
 * `HF_TOKEN`, `AWS_SECRET_ACCESS_KEY` …): always stored and returned as
 * secrets on a Pi instance.
 */
export function isPiKeyEnvName(name: string): boolean {
  return /_(?:API_KEY|TOKEN|SECRET|SECRET_ACCESS_KEY)$/u.test(name.trim().toUpperCase());
}
