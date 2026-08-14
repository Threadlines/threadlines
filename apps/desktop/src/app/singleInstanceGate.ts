/**
 * Decides whether this launch should take Electron's single-instance lock.
 *
 * A second release launch does not fail cleanly: it port-scans past the running
 * backend, then runs a full duplicate stack against the same userData directory
 * and the same SQLite state, corrupting projections and fighting the first
 * process over provider sessions. The lock turns that into a no-op launch that
 * raises the existing window instead.
 *
 * Development is deliberately exempt. Dev runs use their own userData directory
 * and are routinely started next to a release install, so locking them would
 * break the normal workflow rather than protect anything.
 *
 * Like `desktopUserData.ts`, this module is dependency-free and synchronous:
 * `main.ts` has to consult it during module evaluation, long before the Effect
 * runtime and `DesktopConfig` exist.
 */

import { isDesktopDevelopmentEnv, readDesktopEnvAlias } from "./desktopUserData.ts";

export interface SingleInstanceGateConfig {
  /** Vite handed this process a dev-server URL, so it is a development run. */
  readonly isDevelopment: boolean;
  /** `THREADLINES_DISABLE_SINGLE_INSTANCE_LOCK` — operator escape hatch. */
  readonly disabledByEnv: boolean;
}

const ENABLED_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Reads the gate inputs straight from an environment record, mirroring
 * `DesktopConfig` semantics (trimmed values, `THREADLINES_` → `BADCODE_` →
 * `T3CODE_` alias order) for use before the Effect runtime exists.
 */
export const readSingleInstanceGateConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): SingleInstanceGateConfig => {
  const disableFlag = readDesktopEnvAlias(env, [
    "THREADLINES_DISABLE_SINGLE_INSTANCE_LOCK",
    "BADCODE_DISABLE_SINGLE_INSTANCE_LOCK",
    "T3CODE_DISABLE_SINGLE_INSTANCE_LOCK",
  ]);
  return {
    isDevelopment: isDesktopDevelopmentEnv(env),
    disabledByEnv: disableFlag !== undefined && ENABLED_FLAG_VALUES.has(disableFlag.toLowerCase()),
  };
};

export const shouldRequestSingleInstanceLock = (config: SingleInstanceGateConfig): boolean =>
  !config.isDevelopment && !config.disabledByEnv;

export interface SingleInstancePathApi {
  readonly join: (...segments: ReadonlyArray<string>) => string;
}

const SERVER_RUNTIME_STATE_FILE_NAME = "server-runtime.json";

/**
 * Where the running server advertises itself: `server-runtime.json` inside the
 * server state directory. Mirrors the resolution in `DesktopEnvironment`
 * (`THREADLINES_HOME` or `~/.threadlines`, then `dev`/`userdata` by lane) and
 * the server's own `config.serverRuntimeStatePath`, because a denied secondary
 * has to find the file before the Effect runtime exists.
 */
export const resolveServerRuntimeStatePath = (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly path: SingleInstancePathApi;
}): string => {
  const baseDir =
    readDesktopEnvAlias(input.env, ["THREADLINES_HOME", "BADCODE_HOME", "T3CODE_HOME"]) ??
    input.path.join(input.homeDirectory, ".threadlines");
  const stateDirName = isDesktopDevelopmentEnv(input.env) ? "dev" : "userdata";
  return input.path.join(baseDir, stateDirName, SERVER_RUNTIME_STATE_FILE_NAME);
};

/**
 * The unauthenticated readiness URL of the primary's backend, or undefined when
 * the runtime-state file is absent or unusable. The server writes the file when
 * it starts listening and removes it on clean shutdown, so a parsable origin is
 * a claim worth probing, not proof of life — a crash leaves the file behind.
 */
export const resolvePrimaryReadinessProbeUrl = (
  rawRuntimeState: string | undefined,
): string | undefined => {
  if (rawRuntimeState === undefined) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawRuntimeState);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const { origin, version } = parsed as { origin?: unknown; version?: unknown };
  if (version !== 1 || typeof origin !== "string" || !URL.canParse(origin)) {
    return undefined;
  }
  const originUrl = new URL(origin);
  if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
    return undefined;
  }

  return new URL("/.well-known/threadlines/environment", originUrl).href;
};
