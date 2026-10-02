import { isFilesystemPathWithin } from "./path.ts";

// The spellings effect's `Config.boolean` accepts, so the server and the
// desktop shell read `THREADLINES_TELEMETRY_ENABLED` and `CI` the same way.
const TRUE_VALUES = new Set(["true", "yes", "on", "1", "y"]);
const FALSE_VALUES = new Set(["false", "no", "off", "0", "n"]);

/** `true`/`false` for a recognized `THREADLINES_TELEMETRY_ENABLED`, otherwise undefined. */
export function parseTelemetryEnabledOverride(raw: string | undefined): boolean | undefined {
  const value = raw?.trim();
  if (value === undefined) return undefined;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  return undefined;
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
  if (ci && !FALSE_VALUES.has(ci.toLowerCase())) {
    return true;
  }
  return input.baseDirs.some((baseDir) =>
    input.tempDirs.some(
      (tempDir) => tempDir.trim() !== "" && isFilesystemPathWithin(baseDir, tempDir),
    ),
  );
}
