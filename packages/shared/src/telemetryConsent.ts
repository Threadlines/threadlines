import { ENV_FLAG_FALSE_VALUES, parseBooleanEnvFlag } from "./envFlag.ts";
import { isThrowawayDataFolder } from "./throwawayRun.ts";

/**
 * `true`/`false` for a recognized `THREADLINES_TELEMETRY_ENABLED`, otherwise
 * undefined. The server and the desktop shell read it the same way.
 */
export function parseTelemetryEnabledOverride(raw: string | undefined): boolean | undefined {
  return parseBooleanEnvFlag(raw);
}

/**
 * Whether this run is throwaway, so its analytics would only add noise: a CI
 * job (`CI` set to anything but a false value), or a Threadlines data folder
 * inside the system temp folder, which is how smoke tests and agent test runs
 * start fresh. Real installs never keep their data there. An explicit
 * `THREADLINES_TELEMETRY_ENABLED` still wins; callers check it first.
 *
 * Pass every spelling of each folder you know, such as both the configured
 * path and its real path (macOS temp folders live behind `/private`).
 */
export function isThrowawayTelemetryRun(input: {
  readonly baseDirs: ReadonlyArray<string>;
  readonly tempDirs: ReadonlyArray<string>;
  readonly ciEnv: string | undefined;
}): boolean {
  const ci = input.ciEnv?.trim();
  if (ci && !ENV_FLAG_FALSE_VALUES.has(ci.toLowerCase())) {
    return true;
  }
  return isThrowawayDataFolder(input);
}
