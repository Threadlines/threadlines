/**
 * GrokBinary — where the `grok` program is, and how to install and update it.
 *
 * xAI's installers put the binary in `~/.grok/bin` and add that folder to the
 * shell profile. A server started before the install (or from the dock)
 * never reads the profile, so a bare `grok` is looked up on PATH first and
 * in the installer's folder second, each time it runs: a one-click install
 * must work without restarting Threadlines.
 *
 * Update picks the route by where the binary really lives. Grok's own
 * updater only knows npm, its own installer and WinGet: it would write a
 * second copy into `~/.grok/bin` for a Homebrew or Scoop install.
 *
 * @module provider/grok/GrokBinary
 */
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { ProviderDriverKind, type ServerProviderDetection } from "@threadlines/contracts";
import { resolveCommandPath } from "@threadlines/shared/shell";

import { detectProviderBinary, withKnownCliDirsOnPath } from "../providerDetection.ts";
import {
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCommandDefinition,
} from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("grok");
export const GROK_NPM_PACKAGE = "@xai-official/grok";
const GROK_UPDATE_LOCK = "grok";
const GROK_INSTALL_LOCK = "grok-install";

function grokInstallerBinary(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) return undefined;
  const candidate = join(home, ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
  return existsSync(candidate) ? candidate : undefined;
}

/** The binary to run for a configured `binaryPath` (a bare name or a path). */
export function resolveGrokBinary(binaryPath: string, env: NodeJS.ProcessEnv): string {
  const trimmed = binaryPath.trim() || "grok";
  if (/[\\/]/u.test(trimmed)) return trimmed;
  return (
    resolveCommandPath(trimmed, { platform: process.platform, env: withKnownCliDirsOnPath(env) }) ??
    (trimmed === "grok" ? grokInstallerBinary(env) : undefined) ??
    trimmed
  );
}

/** Whether the binary is where `resolveGrokBinary` looks. Reads the filesystem only. */
export function detectGrokBinary(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
): ServerProviderDetection {
  return detectProviderBinary({
    binaryPath: binaryPath.trim() || "grok",
    env,
    knownCliDirs: true,
    fallback: (name) => (name === "grok" ? grokInstallerBinary(env) : undefined),
  });
}

/**
 * xAI's installer, stable channel. `~/.grok/bin` goes on the installer's PATH
 * so it skips linking `grok` and `agent` into `~/.local/bin`, where it would
 * replace Cursor's own `agent` link (install.sh's "already on PATH" check).
 */
const GROK_INSTALL_SH =
  'curl -fsSL https://x.ai/cli/install.sh | GROK_CHANNEL=stable PATH="$HOME/.grok/bin:$PATH" bash';

const GROK_UNIX_INSTALL: ProviderMaintenanceCommandDefinition = {
  executable: "bash",
  args: ["-c", GROK_INSTALL_SH],
  lockKey: GROK_INSTALL_LOCK,
  displayCommand: "curl -fsSL https://x.ai/cli/install.sh | bash",
};

/** https://docs.x.ai/build/overview */
export const GROK_INSTALL: Partial<Record<NodeJS.Platform, ProviderMaintenanceCommandDefinition>> =
  {
    darwin: GROK_UNIX_INSTALL,
    linux: GROK_UNIX_INSTALL,
    win32: {
      executable: "powershell.exe",
      args: ["-NoProfile", "-Command", "irm https://x.ai/cli/install.ps1 | iex"],
      lockKey: GROK_INSTALL_LOCK,
      displayCommand: "irm https://x.ai/cli/install.ps1 | iex",
    },
  };

/** How the binary at this (real) path was installed, for the update route. */
export type GrokInstallKind = "homebrew" | "scoop" | "winget" | "own";

export function grokInstallKind(realPath: string): GrokInstallKind {
  const normalized = normalizeCommandPath(realPath);
  // A cask's `binary` stanza links into Caskroom, not Cellar.
  if (normalized.includes("/caskroom/grok-build/")) return "homebrew";
  if (normalized.includes("/scoop/apps/grok-cli/")) return "scoop";
  if (normalized.includes("/winget/packages/xai.grokbuild")) return "winget";
  return "own";
}

function realPathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function updateCommand(kind: GrokInstallKind, binary: string) {
  switch (kind) {
    case "homebrew":
      return { executable: "brew", args: ["upgrade", "--cask", "grok-build"] };
    case "scoop":
      return { executable: "scoop", args: ["update", "grok-cli"] };
    case "winget":
      return { executable: "winget", args: ["upgrade", "--id", "xAI.GrokBuild", "-e"] };
    case "own":
      // xAI's installer and npm: `grok update` knows both. No `--stable`:
      // it would switch and save the user's channel.
      return { executable: binary, args: ["update"] };
  }
}

/**
 * Install while the binary is missing; otherwise the update for how it was
 * installed. Run with the installation's own environment: an account's
 * `GROK_HOME` would make `grok update` install a private copy nobody runs.
 */
export function grokMaintenance(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): ProviderMaintenanceCapabilities {
  const resolved = resolveGrokBinary(binaryPath, env);
  const found = /[\\/]/u.test(resolved) && existsSync(resolved);
  const bareName = !/[\\/]/u.test(binaryPath.trim() || "grok");
  if (!found) {
    const install = bareName ? GROK_INSTALL[platform] : undefined;
    return makeProviderMaintenanceCapabilities({
      provider: DRIVER_KIND,
      packageName: GROK_NPM_PACKAGE,
      updateExecutable: null,
      updateArgs: [],
      updateLockKey: null,
      install: install
        ? {
            command: install.displayCommand ?? [install.executable, ...install.args].join(" "),
            executable: install.executable,
            args: install.args,
            lockKey: install.lockKey,
          }
        : null,
    });
  }
  const update = updateCommand(grokInstallKind(realPathOf(resolved)), resolved);
  return makeProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: GROK_NPM_PACKAGE,
    updateExecutable: update.executable,
    updateArgs: update.args,
    updateLockKey: GROK_UPDATE_LOCK,
  });
}
