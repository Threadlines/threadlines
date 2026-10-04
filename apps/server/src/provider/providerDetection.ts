// @effect-diagnostics nodeBuiltinImport:off
/**
 * providerDetection — a cheap look for a turned-off provider's program on
 * this computer, so setup screens can say "Found on this Mac" without
 * starting anything.
 *
 * Detection only reads the filesystem. It never spawns a process, touches
 * the network, boots WSL or reads credentials. Each driver calls it with the
 * binary and environment its real probe spawns with, so what it reports
 * agrees with what turning the provider on would find.
 *
 * @module provider/providerDetection
 */
import { posix as PosixPath, win32 as WindowsPath } from "node:path";

import type { ServerProviderDetection } from "@threadlines/contracts";
import {
  type CommandFileSystem,
  resolveCommandPath,
  resolveKnownWindowsCliDirs,
} from "@threadlines/shared/shell";

/**
 * The environment to look a bare CLI name up in for drivers that also search
 * the folders CLI installers use on Windows (after PATH), which a server
 * started before the install may not have on PATH. Unchanged elsewhere.
 */
export function withKnownCliDirsOnPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return env;
  const searchPath = [env.PATH ?? env.Path ?? "", ...resolveKnownWindowsCliDirs(env)]
    .filter((entry) => entry.length > 0)
    .join(";");
  return { ...env, PATH: searchPath };
}

export interface ProviderBinaryDetectionInput {
  /** The configured binary: a bare name looked up on PATH, or a path. */
  readonly binaryPath: string;
  /** The environment the driver spawns with, instance overrides included. */
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** Also search the Windows CLI installer folders, as ACP and OpenCode spawns do. */
  readonly knownCliDirs?: boolean;
  /** Where the driver looks for a bare name PATH lacks (OpenCode's installer folder). */
  readonly fallback?: (name: string) => string | undefined;
  readonly fileSystem?: CommandFileSystem;
}

const isBareCommandName = (binaryPath: string): boolean => !/[\\/]/u.test(binaryPath);

/**
 * Whether a provider's program is on disk where its driver would run it
 * from: a path must be an executable file, a bare name is searched on PATH.
 * Drivers call this from their turned-off branch.
 */
export function detectProviderBinary(input: ProviderBinaryDetectionInput): ServerProviderDetection {
  const platform = input.platform ?? process.platform;
  const binaryPath = input.binaryPath.trim();
  if (binaryPath.length === 0) return { status: "notFound" };
  const env = input.knownCliDirs ? withKnownCliDirsOnPath(input.env, platform) : input.env;
  const found =
    resolveCommandPath(binaryPath, {
      platform,
      env,
      ...(input.fileSystem ? { fileSystem: input.fileSystem } : {}),
    }) ?? (isBareCommandName(binaryPath) ? input.fallback?.(binaryPath) : undefined);
  return detectionAt(found ? absolutePath(found, platform) : undefined);
}

/** `found` at `path` when there is one, else `notFound`. */
export function detectionAt(path: string | null | undefined): ServerProviderDetection {
  return path ? { status: "found", path } : { status: "notFound" };
}

/** Detection for a provider Threadlines cannot look for without starting something. */
export function undetectableProvider(reason: string): ServerProviderDetection {
  return { status: "unknown", reason };
}

/** A relative PATH entry or configured path, made absolute against the server's cwd. */
function absolutePath(path: string, platform: NodeJS.Platform): string {
  const syntax = platform === "win32" ? WindowsPath : PosixPath;
  return syntax.isAbsolute(path) ? path : syntax.resolve(path);
}
