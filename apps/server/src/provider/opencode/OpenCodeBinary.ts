/**
 * OpenCodeBinary — where the `opencode` program is, and how to install and
 * update it.
 *
 * OpenCode's own installer puts the binary in `~/.opencode/bin` and edits the
 * user's shell profile. A server started before the install (or launched
 * from the dock) never reads that profile, so a bare `opencode` is looked up
 * on PATH first and in the installer's directory second. Everything that
 * runs `opencode` (sessions, the status probe, sign-in, update) resolves it
 * here, at the time it runs: a one-click install must work without
 * restarting Threadlines.
 *
 * @module provider/opencode/OpenCodeBinary
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ProviderDriverKind } from "@threadlines/contracts";
import { resolveCommandPath, resolveKnownWindowsCliDirs } from "@threadlines/shared/shell";

import {
  normalizeCommandPath,
  type PackageManagedProviderMaintenanceDefinition,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  type ProviderMaintenanceCommandAction,
  resolvePackageManagedProviderMaintenance,
} from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("opencode");

function openCodeInstallerBinary(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) return undefined;
  const candidate = join(
    home,
    ".opencode",
    "bin",
    process.platform === "win32" ? "opencode.exe" : "opencode",
  );
  return existsSync(candidate) ? candidate : undefined;
}

export function isOpenCodeInstallerCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

/** The binary to run for a configured `binaryPath` (a bare name or a path). */
export function resolveOpenCodeBinary(binaryPath: string, env: NodeJS.ProcessEnv): string {
  const trimmed = binaryPath.trim() || "opencode";
  if (/[\\/]/u.test(trimmed)) return trimmed;
  const searchPath = [env.PATH ?? env.Path ?? "", ...resolveKnownWindowsCliDirs(env)]
    .filter((entry) => entry.length > 0)
    .join(process.platform === "win32" ? ";" : ":");
  return (
    resolveCommandPath(trimmed, {
      platform: process.platform,
      env: process.platform === "win32" ? { ...env, PATH: searchPath } : env,
    }) ??
    (trimmed === "opencode" ? openCodeInstallerBinary(env) : undefined) ??
    trimmed
  );
}

/**
 * The path maintenance should classify: the configured name, unless it only
 * resolves through the installer's directory, which PATH-based detection
 * would otherwise call "not installed" and offer to install again.
 */
export function openCodeMaintenanceBinaryPath(binaryPath: string, env: NodeJS.ProcessEnv): string {
  const resolved = resolveOpenCodeBinary(binaryPath, env);
  return isOpenCodeInstallerCommandPath(resolved) ? resolved : binaryPath.trim() || "opencode";
}

export const OPENCODE_INSTALL_COMMAND = "curl -fsSL https://opencode.ai/v2/install | bash";

/**
 * Install: OpenCode's v2 installer on macOS and Linux (the plain
 * `opencode.ai/install` script still ships 1.x); npm `@opencode/cli`
 * elsewhere, since OpenCode publishes no Windows script for v2.
 * Update: `opencode upgrade --method curl` for installer installs, run by full
 * path so it works before the shell profile is read; npm and Homebrew for
 * those installs. Homebrew carries OpenCode 2 under two names: core's
 * `opencode` and OpenCode's own `anomalyco/tap/opencode-v2`. The keg the
 * binary links into says which one to upgrade.
 */
export function openCodeMaintenanceResolver(
  env: NodeJS.ProcessEnv,
  binaryPath: string,
): ProviderMaintenanceCapabilitiesResolver {
  // The installer writes under HOME, and the binary is looked up under the
  // instance's HOME; an instance that overrides it installs there too.
  const environmentPatch =
    env.HOME && env.HOME !== process.env.HOME ? { environmentPatch: { HOME: env.HOME } } : {};
  const install = {
    executable: "bash",
    args: ["-c", OPENCODE_INSTALL_COMMAND],
    lockKey: "opencode-install",
    displayCommand: OPENCODE_INSTALL_COMMAND,
    ...environmentPatch,
  };
  const definition: PackageManagedProviderMaintenanceDefinition = {
    provider: DRIVER_KIND,
    // OpenCode 2 ships as `@opencode/cli`; `opencode-ai` is the 1.x line.
    npmPackageName: "@opencode/cli",
    homebrewFormula: "opencode",
    nativeInstall: { darwin: install, linux: install },
    nativeUpdate: {
      // Only chosen when this path (or what it links to) is the installer's,
      // so running it by full path updates the binary Threadlines runs.
      executable: resolveOpenCodeBinary(binaryPath, env),
      // Without `--method`, `opencode upgrade` can fail to tell how it was
      // installed; this path is only ever the installer's.
      args: ["upgrade", "--method", "curl"],
      lockKey: "opencode-native",
      isCommandPath: isOpenCodeInstallerCommandPath,
      ...environmentPatch,
    },
  };
  return {
    resolve: (options) =>
      resolvePackageManagedProviderMaintenance(
        options?.realCommandPath &&
          normalizeCommandPath(options.realCommandPath).includes("/cellar/opencode-v2/")
          ? { ...definition, homebrewFormula: "anomalyco/tap/opencode-v2" }
          : definition,
        options,
      ),
  };
}

/**
 * Swapping `opencode-ai` for `@opencode/cli` with the manager that installed
 * it. pnpm 10 and bun skip `@opencode/cli`'s postinstall, which fetches the
 * binary, unless told to run it (pnpm before 10.4 has no `--allow-build`, and
 * pnpm 9 runs it anyway); later plain updates keep that approval.
 */
const ONE_X_PACKAGE_SWAP: Readonly<
  Record<
    string,
    {
      readonly remove: string;
      readonly install: (install: string) => string;
      readonly after?: string;
    }
  >
> = {
  "npm-global": { remove: "npm uninstall -g opencode-ai", install: (install) => install },
  "pnpm-global": {
    remove: "pnpm remove -g opencode-ai",
    install: (install) => `${install} --allow-build=@opencode/cli || ${install}`,
  },
  "bun-global": {
    remove: "bun remove -g opencode-ai",
    install: (install) => install,
    after: "bun pm -g trust @opencode/cli",
  },
};

/** The parts of the instance's environment the move must run with. */
function instanceEnvironmentPatch(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Record<string, string> {
  const patch: Record<string, string> = {};
  if (env.HOME && env.HOME !== process.env.HOME) patch.HOME = env.HOME;
  // Windows spells it `Path` and merges case-insensitively; leave it alone.
  if (platform !== "win32" && env.PATH && env.PATH !== process.env.PATH) patch.PATH = env.PATH;
  return patch;
}

function shellAction(input: {
  readonly steps: ReadonlyArray<string>;
  readonly display: string;
  readonly lockKey: string;
  readonly platform: NodeJS.Platform;
  readonly environmentPatch: Readonly<Record<string, string>>;
}): ProviderMaintenanceCommandAction {
  // Steps run regardless of the one before, so a retry after a half-done
  // move (1.x already removed) still installs OpenCode 2.
  const command = input.steps.join(input.platform === "win32" ? " & " : " ; ");
  return {
    command: input.display,
    ...(input.platform === "win32"
      ? { executable: "cmd.exe", args: ["/d", "/s", "/c", command] }
      : { executable: "/bin/sh", args: ["-c", command] }),
    lockKey: input.lockKey,
    ...(Object.keys(input.environmentPatch).length > 0
      ? { environmentPatch: input.environmentPatch }
      : {}),
  };
}

/**
 * The Update action for an OpenCode 1.x binary: OpenCode 2 is a separate
 * package, so moving to it swaps the install rather than upgrading it, using
 * the method the regular resolution found for this binary.
 *
 * - OpenCode's installer: the v2 installer replaces the binary in place.
 * - npm, pnpm, bun: remove `opencode-ai`, then add `@opencode/cli` (npm
 *   refuses to put one over the other's `opencode`).
 * - Homebrew: the tap's `opencode-v2` conflicts with `opencode`, so the 1.x
 *   formula is uninstalled first.
 *
 * npm and Homebrew need the binary itself to be the `opencode-ai` package or
 * the `opencode` keg, not just a path the regular resolution guessed from.
 * The command path must be a link the manager recreates: a path inside the
 * package or keg (or Homebrew's per-formula `opt` link) is deleted by the
 * move. Anything else (Scoop, Chocolatey, a
 * download, a 1.x installer binary on Windows) gets no action, and the status
 * message says how to install OpenCode 2 by hand.
 *
 * OpenCode 2 migrates its own database in place on first start and 1.x chats
 * carry over; 1.x still reads the migrated database (checked 2026-10-02).
 */
export function openCodeOneMigrationCapabilities(
  capabilities: ProviderMaintenanceCapabilities,
  input: {
    /** The binary as Threadlines runs it (configured or found on PATH). */
    readonly commandPath: string;
    /** `commandPath` with links resolved. */
    readonly realCommandPath: string;
    readonly env: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
  },
): ProviderMaintenanceCapabilities {
  const platform = input.platform ?? process.platform;
  const update = capabilities.update;
  const commandPath = normalizeCommandPath(input.commandPath);
  const realCommandPath = normalizeCommandPath(input.realCommandPath);
  const environmentPatch = {
    ...update?.environmentPatch,
    ...instanceEnvironmentPatch(input.env, platform),
  };
  const action = ((): ProviderMaintenanceCommandAction | null => {
    if (!update) return null;
    if (update.lockKey === "opencode-native") {
      return platform === "win32"
        ? null
        : shellAction({
            steps: [OPENCODE_INSTALL_COMMAND],
            display: OPENCODE_INSTALL_COMMAND,
            lockKey: update.lockKey,
            platform,
            environmentPatch,
          });
    }
    if (commandPath.includes("/cellar/") || commandPath.includes("/node_modules/")) return null;
    if (update.lockKey === "homebrew") {
      // Only Homebrew's shared `bin` link survives: `opt/opencode` belongs to
      // the formula the move uninstalls.
      if (
        !realCommandPath.includes("/cellar/opencode/") ||
        !/\/(?:homebrew|local|\.linuxbrew)\/bin\/opencode$/u.test(commandPath)
      ) {
        return null;
      }
      const steps = ["brew uninstall opencode", "brew install anomalyco/tap/opencode-v2"];
      return shellAction({
        steps,
        display: steps.join(" ; "),
        lockKey: update.lockKey,
        platform,
        environmentPatch,
      });
    }
    const swap = ONE_X_PACKAGE_SWAP[update.lockKey];
    if (!swap) return null;
    if (
      update.lockKey === "npm-global" &&
      !realCommandPath.includes("/node_modules/opencode-ai/") &&
      !update.environmentPatch?.NPM_CONFIG_PREFIX
    ) {
      return null;
    }
    const steps = (remove: string, install: string) => [
      remove,
      swap.after ? `${swap.install(install)} && ${swap.after}` : swap.install(install),
    ];
    const prefix = update.environmentPatch?.NPM_CONFIG_PREFIX;
    return shellAction({
      steps: steps(swap.remove, [update.executable, ...update.args].join(" ")),
      display: steps(
        prefix ? swap.remove.replace("npm ", `npm --prefix "${prefix}" `) : swap.remove,
        update.command,
      ).join(" ; "),
      lockKey: update.lockKey,
      platform,
      environmentPatch,
    });
  })();
  return {
    ...capabilities,
    update: action,
    install: null,
    manualUpdateCommand: null,
    advisoryMessage: action
      ? "Moves this install to OpenCode 2. Your OpenCode chats carry over."
      : null,
  };
}
