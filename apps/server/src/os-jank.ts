import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import {
  readPathFromLoginShell,
  readEnvironmentFromWindowsShell,
  resolveKnownWindowsCliDirs,
  resolveWindowsEnvironment,
  mergePathValues,
  type CommandAvailabilityOptions,
  type WindowsShellEnvironmentReader,
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLaunchctl,
} from "@threadlines/shared/shell";

type WindowsCommandAvailabilityChecker = (
  command: string,
  options?: CommandAvailabilityOptions,
) => boolean;

function logPathHydrationWarning(message: string, error?: unknown): void {
  process.stderr.write(
    `[server] ${message} ${error instanceof Error ? error.message : (error ?? "")}\n`,
  );
}

export function fixPath(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    /**
     * The desktop app already read the user's shell environment into this
     * process, so the blocking login-shell or PowerShell probe is skipped.
     */
    shellEnvironmentPrepared?: boolean;
    readPath?: typeof readPathFromLoginShell;
    readWindowsEnvironment?: WindowsShellEnvironmentReader;
    isWindowsCommandAvailable?: WindowsCommandAvailabilityChecker;
    readLaunchctlPath?: typeof readPathFromLaunchctl;
    userShell?: string;
    logWarning?: (message: string, error?: unknown) => void;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const logWarning = options.logWarning ?? logPathHydrationWarning;
  const readPath = options.readPath ?? readPathFromLoginShell;

  try {
    if (options.shellEnvironmentPrepared) {
      if (platform === "win32") {
        // Same order a probe would leave: known CLI folders first.
        const path = mergePathValues(
          resolveKnownWindowsCliDirs(env).join(";"),
          env.PATH ?? env.Path ?? env.path,
          "win32",
        );
        if (path) env.PATH = path;
      }
      return;
    }

    if (platform === "win32") {
      const repairedEnvironment = resolveWindowsEnvironment(env, {
        readEnvironment: options.readWindowsEnvironment ?? readEnvironmentFromWindowsShell,
        ...(options.isWindowsCommandAvailable
          ? { commandAvailable: options.isWindowsCommandAvailable }
          : {}),
      });
      for (const [key, value] of Object.entries(repairedEnvironment)) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
      return;
    }

    if (platform !== "darwin" && platform !== "linux") return;

    let shellPath: string | undefined;
    for (const shell of listLoginShellCandidates(platform, env.SHELL, options.userShell)) {
      try {
        shellPath = readPath(shell);
      } catch (error) {
        logWarning(`Failed to read PATH from login shell ${shell}.`, error);
      }

      if (shellPath) {
        break;
      }
    }

    const launchctlPath =
      platform === "darwin" && !shellPath
        ? (options.readLaunchctlPath ?? readPathFromLaunchctl)()
        : undefined;
    const mergedPath = mergePathEntries(shellPath ?? launchctlPath, env.PATH, platform);
    if (mergedPath) {
      env.PATH = mergedPath;
    }
  } catch (error) {
    logWarning("Failed to hydrate PATH from the user environment.", error);
  }
}

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(NodeOS.homedir(), input.slice(2));
  }
  return input;
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(NodeOS.homedir(), ".threadlines");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
