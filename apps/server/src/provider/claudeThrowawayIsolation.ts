/**
 * A throwaway Threadlines run keeps Claude in a folder of its own.
 *
 * A run whose data folder sits inside a temp folder is a smoke test or an
 * agent's test run, and it shares the machine with the real install. Left
 * alone, its Claude would use the real normal sign-in: every status check
 * starts a CLI on it, and a CLI that renews the sign-in and then dies with
 * the test run takes the real sign-in with it.
 *
 * So such a run gets `CLAUDE_CONFIG_DIR` pointed inside its own data folder
 * before anything starts Claude. The CLI keys its keychain item off that
 * folder, so the run starts signed out and can neither read nor renew the
 * real sign-in. `THREADLINES_SHARE_CLAUDE_SIGN_IN=true` turns this off for a
 * run that needs the real sign-in on purpose; an explicit `CLAUDE_CONFIG_DIR`
 * is left alone.
 *
 * @module provider/claudeThrowawayIsolation
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { parseBooleanEnvFlag } from "@threadlines/shared/envFlag";
import { isFilesystemPathWithin } from "@threadlines/shared/path";
import { isThrowawayDataFolder } from "@threadlines/shared/throwawayRun";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const SHARE_CLAUDE_SIGN_IN_ENV = "THREADLINES_SHARE_CLAUDE_SIGN_IN";
/** Set on an isolated run to the folder Claude was given; read by the Claude driver. */
export const ISOLATED_CLAUDE_CONFIG_DIR_ENV = "THREADLINES_ISOLATED_CLAUDE_CONFIG_DIR";

/**
 * The Claude folder a throwaway run should use, or `undefined` when the run
 * is a real install, opted out, or already has a Claude folder chosen for it.
 */
export function resolveThrowawayClaudeConfigDir(input: {
  readonly baseDir: string;
  /** Every known spelling of the data folder, such as its real path. */
  readonly baseDirs: ReadonlyArray<string>;
  readonly tempDirs: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly join: (...parts: ReadonlyArray<string>) => string;
}): string | undefined {
  if (parseBooleanEnvFlag(input.environment[SHARE_CLAUDE_SIGN_IN_ENV]) === true) {
    return undefined;
  }
  if ((input.environment.CLAUDE_CONFIG_DIR?.trim() ?? "") !== "") return undefined;
  if (!isThrowawayDataFolder({ baseDirs: input.baseDirs, tempDirs: input.tempDirs })) {
    return undefined;
  }
  return input.join(input.baseDir, "claude-config");
}

/**
 * Points this process, and so every Claude it starts, at the throwaway run's
 * own Claude folder. Call once at server start, before any provider runs.
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` is cleared with it: it outranks
 * `CLAUDE_CONFIG_DIR` when the CLI names its keychain item, and an inherited
 * value (even an empty one) would point back at the real sign-in.
 */
export const isolateThrowawayClaudeSignIn = Effect.fn("isolateThrowawayClaudeSignIn")(function* (
  baseDir: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realPathOrSelf = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => target));
  const tempDir = NodeOS.tmpdir();
  // `/tmp` is not the OS temp folder on macOS, but test runs use it all the same.
  const sharedTempDirs = process.platform === "win32" ? [] : ["/tmp"];
  const configDir = resolveThrowawayClaudeConfigDir({
    baseDir,
    baseDirs: [baseDir, yield* realPathOrSelf(baseDir)],
    tempDirs: [
      tempDir,
      yield* realPathOrSelf(tempDir),
      ...sharedTempDirs,
      ...(yield* Effect.forEach(sharedTempDirs, realPathOrSelf)),
    ],
    environment,
    join: path.join,
  });
  if (configDir === undefined) return undefined;

  environment.CLAUDE_CONFIG_DIR = configDir;
  environment[ISOLATED_CLAUDE_CONFIG_DIR_ENV] = configDir;
  delete environment.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  yield* Effect.logInfo("claude.sign-in.isolated-for-throwaway-run", { configDir });
  return configDir;
});

/**
 * Why a Claude CLI may not be started with `spawnEnvironment` in an isolated
 * throwaway run, or `undefined` when it may (always, outside such a run).
 *
 * Settings copied in from a real install can still point past the isolation:
 * an account folder or `CLAUDE_CONFIG_DIR` outside the run's data folder
 * names a real sign-in (and laying an account folder over the run's main
 * folder would re-link the real account's history), and
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` picks the keychain item whatever the
 * folder is. Every path that starts Claude for an instance checks this.
 */
export function throwawayClaudeSpawnViolation(
  spawnEnvironment: NodeJS.ProcessEnv,
  processEnvironment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const isolatedConfigDir = processEnvironment[ISOLATED_CLAUDE_CONFIG_DIR_ENV]?.trim() ?? "";
  if (isolatedConfigDir === "") return undefined;
  // The isolated folder sits directly inside the run's data folder.
  const dataFolder = NodePath.dirname(isolatedConfigDir);
  const configDir = spawnEnvironment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  const outside = configDir === "" || !isFilesystemPathWithin(configDir, dataFolder);
  if (!outside && spawnEnvironment.CLAUDE_SECURESTORAGE_CONFIG_DIR === undefined) return undefined;
  return `This is a throwaway Threadlines run, so Claude stays inside its own data folder. ${
    outside
      ? "This account's Claude folder is outside it."
      : "This account sets CLAUDE_SECURESTORAGE_CONFIG_DIR, which points at a sign-in outside it."
  } Set ${SHARE_CLAUDE_SIGN_IN_ENV}=true to use your real Claude sign-ins here.`;
}
