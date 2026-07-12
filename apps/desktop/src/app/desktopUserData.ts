/**
 * Resolution of the Electron `userData` location.
 *
 * Chromium computes the sandbox profile for each helper process (GPU, network
 * service) from the userData path that is current when the helper spawns, and
 * the first helpers spawn as soon as the app becomes ready. `userData` must
 * therefore be final synchronously during main-module evaluation — setting it
 * from async startup code races `ready`, and a network service sandboxed
 * against the default profile directory cannot write the disk cache
 * ("Unable to create cache" / "Failed to write a new fake index" on every
 * launch).
 *
 * This module is dependency-free and synchronous so `main.ts` can apply it at
 * module load; `DesktopEnvironment` reuses the same logic with values decoded
 * from `DesktopConfig`.
 */

export interface DesktopUserDataPathApi {
  readonly join: (...segments: ReadonlyArray<string>) => string;
  readonly resolve: (...segments: ReadonlyArray<string>) => string;
}

export interface DesktopUserDataConfig {
  readonly isDevelopment: boolean;
  /** `%APPDATA%` — Windows default profile root. */
  readonly windowsAppDataDirectory: string | undefined;
  /** `$XDG_CONFIG_HOME` — Linux default profile root. */
  readonly xdgConfigHome: string | undefined;
  /** `THREADLINES_DESKTOP_APP_DATA_DIR` — explicit profile root override. */
  readonly appDataDirectoryOverride: string | undefined;
  /** `THREADLINES_DESKTOP_USER_DATA_DIR_NAME` — dev-only dir-name override. */
  readonly userDataDirNameOverride: string | undefined;
}

export interface DesktopUserDataLocation {
  readonly appDataDirectory: string;
  readonly userDataDirName: string;
  readonly legacyUserDataDirName: string;
}

const SAFE_USER_DATA_DIR_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

const trimNonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
};

const firstEnvAlias = (
  env: Readonly<Record<string, string | undefined>>,
  names: ReadonlyArray<string>,
): string | undefined => {
  for (const name of names) {
    const value = trimNonEmpty(env[name]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
};

const isParsableUrl = (value: string): boolean => URL.canParse(value);

/**
 * Reads the userData-relevant configuration straight from an environment
 * record, mirroring `DesktopConfig` semantics (trimmed values, `THREADLINES_`
 * → `BADCODE_` → `T3CODE_` alias order) for use before the Effect runtime
 * exists.
 */
export const readDesktopUserDataConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): DesktopUserDataConfig => {
  const devServerUrl = trimNonEmpty(env["VITE_DEV_SERVER_URL"]);
  return {
    isDevelopment: devServerUrl !== undefined && isParsableUrl(devServerUrl),
    windowsAppDataDirectory: trimNonEmpty(env["APPDATA"]),
    xdgConfigHome: trimNonEmpty(env["XDG_CONFIG_HOME"]),
    appDataDirectoryOverride: firstEnvAlias(env, [
      "THREADLINES_DESKTOP_APP_DATA_DIR",
      "BADCODE_DESKTOP_APP_DATA_DIR",
      "T3CODE_DESKTOP_APP_DATA_DIR",
    ]),
    userDataDirNameOverride: firstEnvAlias(env, [
      "THREADLINES_DESKTOP_USER_DATA_DIR_NAME",
      "BADCODE_DESKTOP_USER_DATA_DIR_NAME",
      "T3CODE_DESKTOP_USER_DATA_DIR_NAME",
    ]),
  };
};

export const resolveDesktopUserDataLocation = (input: {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly config: DesktopUserDataConfig;
  readonly path: DesktopUserDataPathApi;
}): DesktopUserDataLocation => {
  const { config, homeDirectory, path, platform } = input;

  const defaultAppDataDirectory =
    platform === "win32"
      ? (config.windowsAppDataDirectory ?? path.join(homeDirectory, "AppData", "Roaming"))
      : platform === "darwin"
        ? path.join(homeDirectory, "Library", "Application Support")
        : (config.xdgConfigHome ?? path.join(homeDirectory, ".config"));
  const appDataDirectory =
    config.appDataDirectoryOverride !== undefined
      ? path.resolve(config.appDataDirectoryOverride)
      : defaultAppDataDirectory;

  const safeDirNameOverride =
    config.userDataDirNameOverride !== undefined &&
    SAFE_USER_DATA_DIR_NAME_PATTERN.test(config.userDataDirNameOverride) &&
    config.userDataDirNameOverride !== "." &&
    config.userDataDirNameOverride !== ".."
      ? config.userDataDirNameOverride
      : undefined;
  const userDataDirName = config.isDevelopment
    ? (safeDirNameOverride ?? "threadlines-dev")
    : "threadlines";

  return {
    appDataDirectory,
    userDataDirName,
    legacyUserDataDirName: config.isDevelopment ? "badcode-dev" : "badcode",
  };
};

/** Prefers an already-populated legacy directory over the current name. */
export const resolveDesktopUserDataPath = (input: {
  readonly location: DesktopUserDataLocation;
  readonly path: DesktopUserDataPathApi;
  readonly directoryExists: (path: string) => boolean;
}): string => {
  const { directoryExists, location, path } = input;
  const legacyPath = path.join(location.appDataDirectory, location.legacyUserDataDirName);
  return directoryExists(legacyPath)
    ? legacyPath
    : path.join(location.appDataDirectory, location.userDataDirName);
};
