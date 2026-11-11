// @effect-diagnostics nodeBuiltinImport:off
import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@threadlines/contracts";
import { compareSemverVersions } from "@threadlines/shared/semver";
import { resolveCommandPath } from "@threadlines/shared/shell";
import { win32 as WindowsPath } from "node:path";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;
const LATEST_VERSION_TIMEOUT_MS = 4_000;
const PROVIDER_UPDATE_ACTION_TOAST_MESSAGE = "Install the update now or review provider settings.";

/**
 * Where an update route's newest version is published. Release channels can
 * sit behind npm for hours or days, so a route that doesn't install from npm
 * names its own source: comparing it to npm would offer an update that can't
 * deliver the version it promises.
 */
export type ProviderLatestVersionSource =
  | { readonly kind: "npm"; readonly packageName: string }
  /** A URL whose whole body is a version number. */
  | { readonly kind: "releasePointer"; readonly url: string }
  | { readonly kind: "homebrewCask"; readonly token: string }
  | { readonly kind: "homebrewFormula"; readonly name: string };

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  /** Defaults to npm's `packageName`. */
  readonly latestVersionSource?: ProviderLatestVersionSource;
  readonly update: ProviderMaintenanceCommandAction | null;
  /**
   * How Threadlines would put this provider's CLI on the machine when it is
   * missing. Uses the platform installer when available, otherwise npm.
   * `null` means the UI falls back to the provider's install guide.
   */
  readonly install: ProviderMaintenanceCommandAction | null;
  /**
   * The command that puts the whole CLI back when it is there but cannot
   * start (an update that left a file out). Only where reinstalling is known
   * to work and aims at the copy Threadlines runs: npm's and bun's install of
   * `@latest` (both fetch what is missing), `brew reinstall`, and the
   * vendor's installer for a copy sitting where that installer puts it. It
   * shares a lock with every other command that writes that copy. Absent
   * everywhere else.
   */
  readonly repair?: ProviderMaintenanceCommandAction;
  readonly manualUpdateCommand: string | null;
  readonly advisoryMessage: string | null;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  readonly environmentPatch?: Readonly<Record<string, string>>;
  /**
   * Done in-process instead of by spawning `executable` (a managed runtime
   * Threadlines downloads and verifies itself). Its output is shown like a
   * command's; a failure's message is the error.
   */
  readonly run?: Effect.Effect<{ readonly output: string }, { readonly message: string }>;
}

export interface ProviderMaintenanceCommandDefinition {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  readonly displayCommand?: string | null | undefined;
  readonly advisoryMessage?: string | null | undefined;
  readonly environmentPatch?: Readonly<Record<string, string>>;
  readonly latestVersionSource?: ProviderLatestVersionSource;
}

export interface ProviderMaintenanceCapabilityResolutionOptions {
  readonly binaryPath?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly realCommandPath?: string | null;
}

export interface ProviderMaintenanceCapabilitiesResolver {
  readonly resolve: (
    options?: ProviderMaintenanceCapabilityResolutionOptions,
  ) => ProviderMaintenanceCapabilities;
}

export interface PackageManagedProviderMaintenanceDefinition {
  readonly provider: ProviderDriverKind;
  readonly npmPackageName: string;
  readonly homebrewFormula: string | null;
  readonly nativeInstall?: Partial<Record<NodeJS.Platform, ProviderMaintenanceCommandDefinition>>;
  /**
   * The vendor's installer for a native install that cannot start, where it
   * differs from `nativeInstall` (a platform Threadlines installs through npm
   * but whose native copies exist anyway). Run under the update's lock.
   */
  readonly nativeRepair?: Partial<Record<NodeJS.Platform, ProviderMaintenanceCommandDefinition>>;
  readonly nativeUpdate:
    | (ProviderMaintenanceCommandDefinition & {
        readonly isCommandPath: (commandPath: string) => boolean;
        readonly unsupportedOneClickPlatforms?: ReadonlyArray<NodeJS.Platform>;
        readonly platformUpdateOverrides?: Partial<
          Record<NodeJS.Platform, ProviderMaintenanceCommandDefinition>
        >;
        readonly manualCommand?: string | null | undefined;
        readonly advisoryMessage?: string | null | undefined;
      })
    | null;
}

interface LatestVersionCacheEntry {
  readonly expiresAt: number;
  readonly version: string | null;
}

const latestVersionCache = new Map<string, LatestVersionCacheEntry>();
const decodeNpmLatestVersion = Schema.decodeUnknownEffect(
  Schema.Struct({ version: Schema.optional(Schema.String) }),
);
const decodeHomebrewCask = Schema.decodeUnknownEffect(
  Schema.Struct({ version: Schema.optional(Schema.String) }),
);
const decodeHomebrewFormula = Schema.decodeUnknownEffect(
  Schema.Struct({
    versions: Schema.optional(Schema.Struct({ stable: Schema.optional(Schema.String) })),
  }),
);

export function clearLatestProviderVersionCacheForTests(): void {
  latestVersionCache.clear();
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function makeProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly updateExecutable: string | null;
  readonly updateArgs: ReadonlyArray<string>;
  readonly updateLockKey: string | null;
  readonly updateDisplayCommand?: string | null | undefined;
  readonly updateEnvironmentPatch?: Readonly<Record<string, string>> | undefined;
  readonly install?: ProviderMaintenanceCommandAction | null | undefined;
  readonly repair?: ProviderMaintenanceCommandAction | undefined;
  /** The update command reinstalls the whole CLI, so it is the repair too. */
  readonly updateAlsoRepairs?: boolean | undefined;
  readonly manualUpdateCommand?: string | null | undefined;
  readonly advisoryMessage?: string | null | undefined;
  readonly latestVersionSource?: ProviderLatestVersionSource | undefined;
}): ProviderMaintenanceCapabilities {
  const update =
    input.updateExecutable === null || input.updateLockKey === null
      ? null
      : {
          command:
            input.updateDisplayCommand ?? [input.updateExecutable, ...input.updateArgs].join(" "),
          executable: input.updateExecutable,
          args: input.updateArgs,
          lockKey: input.updateLockKey,
          ...(input.updateEnvironmentPatch
            ? { environmentPatch: input.updateEnvironmentPatch }
            : {}),
        };
  return {
    provider: input.provider,
    packageName: input.packageName,
    ...(input.latestVersionSource ? { latestVersionSource: input.latestVersionSource } : {}),
    update,
    install: input.install ?? null,
    ...(input.repair
      ? { repair: input.repair }
      : input.updateAlsoRepairs && update
        ? { repair: update }
        : {}),
    manualUpdateCommand: input.manualUpdateCommand ?? null,
    advisoryMessage: input.advisoryMessage ?? null,
  };
}

export function makeManualOnlyProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly manualUpdateCommand?: string | null | undefined;
  readonly advisoryMessage?: string | null | undefined;
  readonly latestVersionSource?: ProviderLatestVersionSource | undefined;
}): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: input.provider,
    packageName: input.packageName,
    updateExecutable: null,
    updateArgs: [],
    updateLockKey: null,
    manualUpdateCommand: input.manualUpdateCommand,
    advisoryMessage: input.advisoryMessage,
    latestVersionSource: input.latestVersionSource,
  });
}

/**
 * `npm install -g <pkg>@latest`. Installing and updating an npm-managed CLI
 * are the same command, so both capabilities are built from here and share
 * the `npm-global` lock key that serializes them against each other.
 */
function makeNpmGlobalCommandAction(input: {
  readonly packageName: string;
  readonly prefix?: string | undefined;
}): ProviderMaintenanceCommandAction {
  const args = ["install", "-g", `${input.packageName}@latest`];
  return {
    command: input.prefix
      ? `npm --prefix "${input.prefix}" install -g ${input.packageName}@latest`
      : ["npm", ...args].join(" "),
    executable: "npm",
    args,
    lockKey: "npm-global",
    ...(input.prefix ? { environmentPatch: { NPM_CONFIG_PREFIX: input.prefix } } : {}),
  };
}

/** Runs a provider's official Windows installer without interpolating shell arguments. */
export function makeWindowsNativeInstaller(input: {
  readonly url: string;
  readonly lockKey: string;
  readonly environmentPatch?: Readonly<Record<string, string>>;
}): ProviderMaintenanceCommandDefinition {
  const command = `irm '${input.url.replaceAll("'", "''")}' | iex`;
  const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ${command}`;
  return {
    executable: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    lockKey: input.lockKey,
    displayCommand: `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${command}"`,
    ...(input.environmentPatch ? { environmentPatch: input.environmentPatch } : {}),
  };
}

/** A command definition as a runnable action, under `lockKey` when it must share another command's lock. */
export function commandActionFrom(
  definition: ProviderMaintenanceCommandDefinition,
  lockKey: string = definition.lockKey,
): ProviderMaintenanceCommandAction {
  return {
    executable: definition.executable,
    args: definition.args,
    lockKey,
    command: definition.displayCommand ?? [definition.executable, ...definition.args].join(" "),
    ...(definition.environmentPatch ? { environmentPatch: definition.environmentPatch } : {}),
  };
}

/**
 * A vendor's installer run again over a copy it made. Installers write under
 * HOME, and the copy was found under the instance's: an instance with its own
 * HOME reinstalls there, not in the server's.
 */
export function installerReinstallAction(
  installer: ProviderMaintenanceCommandDefinition,
  lockKey: string,
  env: NodeJS.ProcessEnv | undefined,
): ProviderMaintenanceCommandAction {
  const action = commandActionFrom(installer, lockKey);
  const home = env?.HOME;
  return home && home !== process.env.HOME && !action.environmentPatch?.HOME
    ? { ...action, environmentPatch: { ...action.environmentPatch, HOME: home } }
    : action;
}

/**
 * npm's prefix for a CLI whose real path is inside
 * `<prefix>/lib/node_modules/<package>/` (macOS and Linux), so a reinstall
 * lands on that copy and not on whichever npm is first on PATH. The package's
 * own folder is the anchor: a prefix may itself sit under a `lib/node_modules`.
 * Null for any other layout.
 */
export function npmGlobalPrefixOf(commandPath: string, packageName: string): string | null {
  const index = normalizeCommandPath(commandPath).lastIndexOf(
    `/lib/node_modules/${packageName.toLowerCase()}/`,
  );
  return index > 0 ? commandPath.slice(0, index) : null;
}

/**
 * `npm install -g <pkg>@latest` aimed at the npm tree this CLI was found in
 * (by its real path, or by npm's shim folder on Windows), or null when it is
 * not in one. For drivers that update through the CLI itself, which a CLI
 * that cannot start cannot do.
 */
export function npmGlobalReinstallAction(input: {
  readonly packageName: string;
  /** The command as Threadlines runs it; on Windows, npm's `.cmd` shim. */
  readonly commandPath: string;
  readonly realCommandPath: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  /** The lock of whatever else writes this copy, when that is not npm itself. */
  readonly lockKey?: string | undefined;
}): ProviderMaintenanceCommandAction | null {
  const prefix =
    npmGlobalPrefixOf(input.realCommandPath, input.packageName) ??
    resolveWindowsNpmGlobalPrefix({
      commandPath: input.commandPath,
      env: input.env,
      platform: input.platform ?? process.platform,
    });
  if (!prefix) {
    return null;
  }
  const action = makeNpmGlobalCommandAction({ packageName: input.packageName, prefix });
  return input.lockKey ? { ...action, lockKey: input.lockKey } : action;
}

/** Prefer a native platform installer, preserving an explicitly configured npm prefix. */
function resolveDefaultInstallAction(
  definition: PackageManagedProviderMaintenanceDefinition,
  options?: ProviderMaintenanceCapabilityResolutionOptions,
): ProviderMaintenanceCommandAction | null {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const nativeInstall = definition.nativeInstall?.[platform];
  // An explicit npm prefix is a user's installation choice.
  if (nativeInstall && !nonEmptyString(env.NPM_CONFIG_PREFIX)) {
    return commandActionFrom(nativeInstall);
  }
  if (!resolveCommandPath("npm", { platform, env })) {
    return null;
  }
  const prefix = nonEmptyString(env.NPM_CONFIG_PREFIX);
  return makeNpmGlobalCommandAction({
    packageName: definition.npmPackageName,
    ...(prefix ? { prefix } : {}),
  });
}

function makeNpmGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  options?: {
    readonly prefix?: string | undefined;
    readonly install?: ProviderMaintenanceCommandAction | null | undefined;
    /** The CLI was found in npm's global folder, so the update also reinstalls that copy. */
    readonly foundInNpmGlobal?: boolean | undefined;
    /** That folder's prefix, when the path shows it: the reinstall is aimed there. */
    readonly foundPrefix?: string | null | undefined;
  },
): ProviderMaintenanceCapabilities {
  const update = makeNpmGlobalCommandAction({
    packageName: definition.npmPackageName,
    ...(options?.prefix ? { prefix: options.prefix } : {}),
  });
  const reinstall =
    options?.foundPrefix && !options.prefix
      ? makeNpmGlobalCommandAction({
          packageName: definition.npmPackageName,
          prefix: options.foundPrefix,
        })
      : update;
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: update.executable,
    updateArgs: update.args,
    updateLockKey: update.lockKey,
    updateDisplayCommand: update.command,
    ...(update.environmentPatch ? { updateEnvironmentPatch: update.environmentPatch } : {}),
    ...(options?.install ? { install: options.install } : {}),
    // A missing CLI that npm is about to install is repaired by that same
    // command, prefix included; one found in npm's folder by its update.
    ...(options?.foundInNpmGlobal
      ? { repair: reinstall }
      : options?.install?.lockKey === update.lockKey
        ? { repair: options.install }
        : {}),
  });
}

/** bun's home for a command found in `<home>/bin/` (`~/.bun` unless `BUN_INSTALL` moved it). */
function bunInstallOf(commandPaths: ReadonlyArray<string>): string | null {
  for (const commandPath of commandPaths) {
    const index = normalizeCommandPath(commandPath).lastIndexOf("/.bun/bin/");
    if (index >= 0) {
      return commandPath.slice(0, index + "/.bun".length);
    }
  }
  return null;
}

function makeBunGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  commandPaths: ReadonlyArray<string>,
): ProviderMaintenanceCapabilities {
  const args = ["i", "-g", `${definition.npmPackageName}@latest`];
  const bunInstall = bunInstallOf(commandPaths);
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "bun",
    updateArgs: args,
    updateLockKey: "bun-global",
    // Checked with bun 1.3: the same command fetches a platform package that
    // went missing. Aimed at the bun home this copy was found in.
    repair: {
      command: ["bun", ...args].join(" "),
      executable: "bun",
      args,
      lockKey: "bun-global",
      ...(bunInstall ? { environmentPatch: { BUN_INSTALL: bunInstall } } : {}),
    },
  });
}

function makePnpmGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "pnpm",
    updateArgs: ["add", "-g", `${definition.npmPackageName}@latest`],
    updateLockKey: "pnpm-global",
  });
}

function makeVitePlusGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "vp",
    updateArgs: ["i", "-g", definition.npmPackageName],
    updateLockKey: "vite-plus-global",
  });
}

/**
 * The cask a command path belongs to. A cask's `binary` stanza links into
 * Caskroom, and one tool can ship as several casks (`claude-code` and
 * `claude-code@latest`), so the path says which one is installed.
 */
function homebrewCaskToken(commandPaths: ReadonlyArray<string>): string | null {
  for (const commandPath of commandPaths) {
    const token = /\/caskroom\/([a-z0-9][a-z0-9@._+-]*)\//.exec(
      normalizeCommandPath(commandPath),
    )?.[1];
    if (token) {
      return token;
    }
  }
  return null;
}

/**
 * Homebrew publishes what `brew upgrade` will install, except for third-party
 * taps (a `/` in the name) and paths that don't show how it was installed.
 * Those stay on the default source.
 */
function homebrewLatestVersionSource(input: {
  readonly formula: string;
  readonly caskToken: string | null;
  readonly commandPaths: ReadonlyArray<string>;
}): ProviderLatestVersionSource | undefined {
  if (input.caskToken) {
    return { kind: "homebrewCask", token: input.caskToken };
  }
  const isCoreFormula =
    !input.formula.includes("/") &&
    input.commandPaths.some((commandPath) =>
      normalizeCommandPath(commandPath).includes("/cellar/"),
    );
  return isCoreFormula ? { kind: "homebrewFormula", name: input.formula } : undefined;
}

/**
 * The `brew` of the Homebrew a command belongs to, so a Mac with both an
 * Intel and an Apple silicon Homebrew reinstalls into the right one. Null
 * when the paths don't show a Homebrew prefix.
 */
function homebrewBrewPath(commandPaths: ReadonlyArray<string>): string | null {
  for (const commandPath of commandPaths) {
    const normalized = normalizeCommandPath(commandPath);
    const keg = /\/(?:cellar|caskroom)\//u.exec(normalized);
    const bin = /^(?:\/opt\/homebrew|\/usr\/local|.*\/\.linuxbrew)(?=\/bin\/)/u.exec(normalized);
    const prefixLength = keg ? keg.index : bin ? bin[0].length : 0;
    if (prefixLength > 0) {
      return `${commandPath.slice(0, prefixLength)}/bin/brew`;
    }
  }
  return null;
}

/** `brew reinstall`, which puts a formula's or cask's files back whatever state they are in. */
export function homebrewReinstallAction(input: {
  readonly target: { readonly cask: string } | { readonly formula: string };
  /** Where the command was found (as run, and with links resolved). */
  readonly commandPaths: ReadonlyArray<string>;
  readonly lockKey?: string | undefined;
}): ProviderMaintenanceCommandAction {
  const args =
    "cask" in input.target
      ? ["reinstall", "--cask", input.target.cask]
      : ["reinstall", input.target.formula];
  return {
    command: ["brew", ...args].join(" "),
    executable: homebrewBrewPath(input.commandPaths) ?? "brew",
    args,
    lockKey: input.lockKey ?? "homebrew",
  };
}

function makeHomebrewProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  commandPaths: ReadonlyArray<string>,
): ProviderMaintenanceCapabilities {
  if (!definition.homebrewFormula) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
    });
  }

  const caskToken = homebrewCaskToken(commandPaths);
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "brew",
    updateArgs: ["upgrade", caskToken ?? definition.homebrewFormula],
    updateLockKey: "homebrew",
    repair: homebrewReinstallAction({
      target: caskToken ? { cask: caskToken } : { formula: definition.homebrewFormula },
      commandPaths,
    }),
    latestVersionSource: homebrewLatestVersionSource({
      formula: definition.homebrewFormula,
      caskToken,
      commandPaths,
    }),
  });
}

function makeNativeProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv | undefined,
  updateOverride?: ProviderMaintenanceCommandDefinition,
): ProviderMaintenanceCapabilities | null {
  if (!definition.nativeUpdate) {
    return null;
  }
  const update = updateOverride ?? definition.nativeUpdate;
  // The copy was found where the vendor's installer puts it, so running that
  // installer again replaces it. The update often runs the CLI itself, which
  // a CLI that cannot start cannot do.
  const installer = definition.nativeRepair?.[platform] ?? definition.nativeInstall?.[platform];

  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: update.executable,
    updateArgs: update.args,
    updateLockKey: update.lockKey,
    updateDisplayCommand: update.displayCommand,
    ...(update.environmentPatch ? { updateEnvironmentPatch: update.environmentPatch } : {}),
    ...(installer ? { repair: installerReinstallAction(installer, update.lockKey, env) } : {}),
    advisoryMessage: update.advisoryMessage ?? definition.nativeUpdate.advisoryMessage,
    latestVersionSource: update.latestVersionSource ?? definition.nativeUpdate.latestVersionSource,
  });
}

function makeNativeManualOnlyProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    manualUpdateCommand: definition.nativeUpdate?.manualCommand ?? null,
    advisoryMessage: definition.nativeUpdate?.advisoryMessage ?? null,
    latestVersionSource: definition.nativeUpdate?.latestVersionSource,
  });
}

export function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

export function normalizeCommandPath(commandPath: string): string {
  return commandPath.replaceAll("\\", "/").toLowerCase();
}

function isBunGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.bun/bin/");
}

function isVitePlusGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.vite-plus/bin/");
}

function isPnpmGlobalCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/.local/share/pnpm/") ||
    normalized.includes("/library/pnpm/") ||
    normalized.includes("/local/share/pnpm/") ||
    normalized.includes("/appdata/local/pnpm/") ||
    normalized.includes("/pnpm/global/")
  );
}

function isNpmGlobalCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/node_modules/.bin/") ||
    normalized.includes("/lib/node_modules/") ||
    normalized.includes("/npm/node_modules/")
  );
}

function resolveWindowsNpmGlobalPrefix(input: {
  readonly commandPath: string;
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly platform: NodeJS.Platform;
}): string | null {
  if (
    input.platform !== "win32" ||
    WindowsPath.extname(input.commandPath).toLowerCase() !== ".cmd"
  ) {
    return null;
  }

  const commandDirectory = WindowsPath.dirname(input.commandPath);
  const normalizedCommandDirectory = normalizeCommandPath(commandDirectory);
  const appData = nonEmptyString(input.env?.APPDATA);
  const roamingNpmDirectory = appData ? WindowsPath.join(appData, "npm") : null;
  if (
    roamingNpmDirectory &&
    normalizedCommandDirectory === normalizeCommandPath(roamingNpmDirectory)
  ) {
    return commandDirectory;
  }
  if (
    normalizedCommandDirectory.includes("/fnm_multishells/") ||
    normalizedCommandDirectory.includes("/fnm/node-versions/")
  ) {
    return commandDirectory;
  }

  const npmCommandPath = resolveCommandPath("npm", {
    platform: input.platform,
    ...(input.env ? { env: input.env } : {}),
  });
  if (
    npmCommandPath &&
    normalizeCommandPath(WindowsPath.dirname(npmCommandPath)) === normalizedCommandDirectory
  ) {
    return commandDirectory;
  }

  return null;
}

function isHomebrewCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/opt/homebrew/cellar/") ||
    normalized.includes("/usr/local/cellar/") ||
    normalized.includes("/homebrew/cellar/") ||
    normalized.includes("/opt/homebrew/caskroom/") ||
    normalized.includes("/usr/local/caskroom/") ||
    normalized.includes("/homebrew/caskroom/") ||
    normalized.startsWith("/opt/homebrew/bin/") ||
    normalized.startsWith("/usr/local/bin/") ||
    // Homebrew on Linux: /home/linuxbrew/.linuxbrew or ~/.linuxbrew.
    normalized.includes("/.linuxbrew/")
  );
}

export function resolvePackageManagedProviderMaintenance(
  definition: PackageManagedProviderMaintenanceDefinition,
  options?: ProviderMaintenanceCapabilityResolutionOptions,
): ProviderMaintenanceCapabilities {
  const binaryPath = nonEmptyString(options?.binaryPath);
  const platform = options?.platform ?? process.platform;
  if (!binaryPath) {
    return makeNpmGlobalProviderMaintenanceCapabilities(definition, {
      install: resolveDefaultInstallAction(definition, options),
    });
  }

  const resolvedCommandPath =
    resolveCommandPath(binaryPath, {
      ...(options?.platform ? { platform: options.platform } : {}),
      ...(options?.env ? { env: options.env } : {}),
    }) ?? (hasPathSeparator(binaryPath) ? binaryPath : null);

  if (resolvedCommandPath) {
    const commandPaths = [
      resolvedCommandPath,
      ...(options?.realCommandPath ? [options.realCommandPath] : []),
    ];

    const nativeUpdate = definition.nativeUpdate;
    if (
      nativeUpdate &&
      commandPaths.some((commandPath) => nativeUpdate.isCommandPath(commandPath))
    ) {
      const platformUpdateOverride = nativeUpdate.platformUpdateOverrides?.[platform];
      if (platformUpdateOverride) {
        return (
          makeNativeProviderMaintenanceCapabilities(
            definition,
            platform,
            options?.env,
            platformUpdateOverride,
          ) ?? makeNpmGlobalProviderMaintenanceCapabilities(definition)
        );
      }
      if (nativeUpdate.unsupportedOneClickPlatforms?.includes(platform)) {
        return makeNativeManualOnlyProviderMaintenanceCapabilities(definition);
      }
      return (
        makeNativeProviderMaintenanceCapabilities(definition, platform, options?.env) ??
        makeNpmGlobalProviderMaintenanceCapabilities(definition)
      );
    }
    if (commandPaths.some(isVitePlusGlobalCommandPath)) {
      return makeVitePlusGlobalProviderMaintenanceCapabilities(definition);
    }
    if (commandPaths.some(isBunGlobalCommandPath)) {
      return makeBunGlobalProviderMaintenanceCapabilities(definition, commandPaths);
    }
    if (commandPaths.some(isPnpmGlobalCommandPath)) {
      return makePnpmGlobalProviderMaintenanceCapabilities(definition);
    }
    const windowsNpmPrefix = resolveWindowsNpmGlobalPrefix({
      commandPath: resolvedCommandPath,
      env: options?.env,
      platform,
    });
    if (windowsNpmPrefix) {
      return makeNpmGlobalProviderMaintenanceCapabilities(definition, {
        prefix: windowsNpmPrefix,
        foundInNpmGlobal: true,
      });
    }
    if (commandPaths.some(isNpmGlobalCommandPath)) {
      return makeNpmGlobalProviderMaintenanceCapabilities(definition, {
        foundInNpmGlobal: true,
        foundPrefix: commandPaths
          .map((commandPath) => npmGlobalPrefixOf(commandPath, definition.npmPackageName))
          .find((prefix) => prefix !== null),
      });
    }
    if (commandPaths.some(isHomebrewCommandPath)) {
      return makeHomebrewProviderMaintenanceCapabilities(definition, commandPaths);
    }
  }

  // A bare command name that resolved nowhere: the CLI is not installed, so
  // this is the one place an install capability is derived. A bare name that
  // did resolve but matched no known manager falls through here too, and
  // there is nothing to install for it.
  if (!hasPathSeparator(binaryPath)) {
    return makeNpmGlobalProviderMaintenanceCapabilities(definition, {
      install:
        resolvedCommandPath === null ? resolveDefaultInstallAction(definition, options) : null,
    });
  }

  return makeManualOnlyProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
  });
}

export function makePackageManagedProviderMaintenanceResolver(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: (options) => resolvePackageManagedProviderMaintenance(definition, options),
  };
}

export function makeStaticProviderMaintenanceResolver(
  capabilities: ProviderMaintenanceCapabilities,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: () => capabilities,
  };
}

function makeManualProviderMaintenanceCapabilities(
  provider: ProviderDriverKind,
): ProviderMaintenanceCapabilities {
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  });
}

export const resolveProviderMaintenanceCapabilitiesEffect = Effect.fn(
  "resolveProviderMaintenanceCapabilitiesEffect",
)(function* (
  resolver: ProviderMaintenanceCapabilitiesResolver,
  options?: Omit<ProviderMaintenanceCapabilityResolutionOptions, "realCommandPath">,
) {
  const binaryPath = nonEmptyString(options?.binaryPath);
  if (!binaryPath) {
    return resolver.resolve(options);
  }

  const resolvedCommandPath =
    resolveCommandPath(binaryPath, {
      ...(options?.platform ? { platform: options.platform } : {}),
      ...(options?.env ? { env: options.env } : {}),
    }) ?? (hasPathSeparator(binaryPath) ? binaryPath : null);
  if (!resolvedCommandPath) {
    return resolver.resolve(options);
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const realCommandPath = yield* fileSystem
    .realPath(resolvedCommandPath)
    .pipe(Effect.catch(() => Effect.succeed(resolvedCommandPath)));
  return resolver.resolve({
    ...options,
    realCommandPath,
  });
});

function deriveVersionAdvisory(input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
}): Pick<ServerProviderVersionAdvisory, "status" | "message"> {
  if (!input.currentVersion) {
    return { status: "unknown", message: null };
  }
  if (!input.latestVersion) {
    return { status: "unknown", message: null };
  }
  if (compareSemverVersions(input.currentVersion, input.latestVersion) < 0) {
    return {
      status: "behind_latest",
      message: PROVIDER_UPDATE_ACTION_TOAST_MESSAGE,
    };
  }
  return { status: "current", message: null };
}

export function createProviderVersionAdvisory(input: {
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
  readonly latestVersion?: string | null;
  readonly checkedAt?: string | null;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
}): ServerProviderVersionAdvisory {
  const capabilities =
    input.maintenanceCapabilities ?? makeManualProviderMaintenanceCapabilities(input.driver);
  const latestVersion = input.latestVersion ?? null;
  const advisory = deriveVersionAdvisory({
    currentVersion: input.currentVersion,
    latestVersion,
  });
  const advisoryMessage =
    advisory.status === "behind_latest"
      ? (capabilities.advisoryMessage ?? advisory.message)
      : advisory.message;

  return {
    status: advisory.status,
    currentVersion: input.currentVersion,
    latestVersion,
    updateCommand: capabilities.update?.command ?? capabilities.manualUpdateCommand,
    canUpdate: capabilities.update !== null,
    installCommand: capabilities.install?.command ?? null,
    canInstall: capabilities.install !== null,
    ...(capabilities.repair ? { canRepair: true, repairCommand: capabilities.repair.command } : {}),
    checkedAt: input.checkedAt ?? null,
    message: advisoryMessage,
  };
}

function latestVersionSourceUrl(source: ProviderLatestVersionSource): string {
  switch (source.kind) {
    case "npm":
      return `https://registry.npmjs.org/${encodeURIComponent(source.packageName)}/latest`;
    case "releasePointer":
      return source.url;
    case "homebrewCask":
      return `https://formulae.brew.sh/api/cask/${source.token}.json`;
    case "homebrewFormula":
      return `https://formulae.brew.sh/api/formula/${source.name}.json`;
  }
}

/** Pulls the version out of a source's response. `undefined` when it has none. */
function readLatestVersionResponse(
  source: ProviderLatestVersionSource,
  response: HttpClientResponse.HttpClientResponse,
) {
  switch (source.kind) {
    case "npm":
      return response.json.pipe(
        Effect.flatMap(decodeNpmLatestVersion),
        Effect.map((payload) => payload.version),
      );
    case "releasePointer":
      return response.text.pipe(
        Effect.map((text) => (/^\d+\.\d+\.\d+/.test(text.trim()) ? text : undefined)),
      );
    case "homebrewCask":
      // A cask version can carry a build after a comma: `1.2.3,456`.
      return response.json.pipe(
        Effect.flatMap(decodeHomebrewCask),
        Effect.map((payload) => payload.version?.split(",")[0]),
      );
    case "homebrewFormula":
      return response.json.pipe(
        Effect.flatMap(decodeHomebrewFormula),
        Effect.map((payload) => payload.versions?.stable),
      );
  }
}

const fetchLatestVersion = Effect.fn("fetchLatestVersion")(function* (
  source: ProviderLatestVersionSource,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(HttpClientRequest.get(latestVersionSourceUrl(source)))
    .pipe(
      Effect.timeoutOption(LATEST_VERSION_TIMEOUT_MS),
      Effect.catch(() => Effect.succeed(Option.none())),
    );
  if (Option.isNone(response)) {
    return null;
  }
  const httpResponse = response.value;
  if (httpResponse.status < 200 || httpResponse.status >= 300) {
    return null;
  }
  const version = yield* readLatestVersionResponse(source, httpResponse).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  return nonEmptyString(version);
});

export const resolveLatestProviderVersion = Effect.fn("resolveLatestProviderVersion")(function* (
  maintenanceCapabilities: ProviderMaintenanceCapabilities,
) {
  const packageName = maintenanceCapabilities.packageName;
  const source: ProviderLatestVersionSource | null =
    maintenanceCapabilities.latestVersionSource ??
    (packageName ? { kind: "npm", packageName } : null);
  if (!source) {
    return null;
  }

  const cacheKey = latestVersionSourceUrl(source);
  const cached = latestVersionCache.get(cacheKey);
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  if (cached && cached.expiresAt > now) {
    return cached.version;
  }

  const version = yield* fetchLatestVersion(source);
  latestVersionCache.set(cacheKey, {
    expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
    version,
  });
  return version;
});

export const enrichProviderSnapshotWithVersionAdvisory = Effect.fn(
  "enrichProviderSnapshotWithVersionAdvisory",
)(function* (snapshot: ServerProvider, maintenanceCapabilities?: ProviderMaintenanceCapabilities) {
  const capabilities =
    maintenanceCapabilities ?? makeManualProviderMaintenanceCapabilities(snapshot.driver);
  if (!snapshot.enabled || !snapshot.installed || !snapshot.version) {
    return {
      ...snapshot,
      versionAdvisory: createProviderVersionAdvisory({
        driver: snapshot.driver,
        currentVersion: snapshot.version,
        checkedAt: snapshot.checkedAt,
        maintenanceCapabilities: capabilities,
      }),
    };
  }

  // The route's published version first; CLIs without one report their newest
  // release from their own probe, which the snapshot's advisory already carries.
  const latestVersion =
    (yield* resolveLatestProviderVersion(capabilities)) ??
    snapshot.versionAdvisory?.latestVersion ??
    null;
  return {
    ...snapshot,
    versionAdvisory: createProviderVersionAdvisory({
      driver: snapshot.driver,
      currentVersion: snapshot.version,
      latestVersion,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      maintenanceCapabilities: capabilities,
    }),
  };
});
