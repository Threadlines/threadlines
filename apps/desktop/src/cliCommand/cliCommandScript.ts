/**
 * The `threadlines` command the desktop app puts on PATH
 * (docs/design/outside-agents.md, "Putting it on PATH"): where it goes on
 * each platform, the script it is, and how to tell this app's script from
 * another copy's.
 *
 * The script runs the app's own runtime, as VS Code's `code` does: the app's
 * executable as Node (`ELECTRON_RUN_AS_NODE=1`) on the app's server bundle.
 * It sets `THREADLINES_CLI_ONLY=1`, so it never starts a second server on the
 * app's data folder, and the app's THREADLINES_HOME when that isn't the
 * default. An AppImage is mounted somewhere new on every launch, so its
 * script runs the AppImage file itself, which hands the command on
 * (appImageCommand.ts).
 */
import type * as Path from "effect/Path";

/** Set by an AppImage's script: the app's main process runs the command instead of the app. */
export const APPIMAGE_COMMAND_ENV = "THREADLINES_APPIMAGE_COMMAND";
/** Comes before the command's own arguments, after anything the AppImage launcher adds. */
export const APPIMAGE_COMMAND_FLAG = "--threadlines-command";

const HEADER =
  "The threadlines command, put here by the Threadlines app (Settings > Connections > Agents).";

/** How the app runs: what the script starts. */
export interface CliCommandLaunch {
  readonly platform: NodeJS.Platform;
  /** The app's executable. */
  readonly executablePath: string;
  /** The app's server bundle, `apps/server/dist/bin.mjs`. */
  readonly entryPath: string;
  /** The app's data folder, when it isn't `~/.threadlines`. */
  readonly threadlinesHome: string | null;
  /** The AppImage file the app runs from, if it does. */
  readonly appImagePath: string | null;
}

export const cliCommandFileName = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "threadlines.cmd" : "threadlines";

/**
 * Where Install puts the command: `/usr/local/bin` on macOS (on PATH by
 * default, written through the administrator prompt),
 * `%LOCALAPPDATA%\Threadlines\bin` on Windows (added to the user's PATH),
 * `~/.local/bin` on Linux.
 */
export function cliCommandDirectory(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly localAppData: string | undefined;
  readonly path: Path.Path;
}): string {
  const { join } = input.path;
  if (input.platform === "darwin") return "/usr/local/bin";
  if (input.platform === "win32") {
    return join(
      input.localAppData ?? join(input.homeDirectory, "AppData", "Local"),
      "Threadlines",
      "bin",
    );
  }
  return join(input.homeDirectory, ".local", "bin");
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** A path inside a batch file: `%` would start a variable. Windows paths hold no `"`. */
const batchQuote = (value: string) => `"${value.replaceAll("%", "%%")}"`;

export function renderCliCommandScript(launch: CliCommandLaunch): string {
  if (launch.platform === "win32") {
    return [
      "@echo off",
      `rem ${HEADER}`,
      "setlocal",
      "set ELECTRON_RUN_AS_NODE=1",
      "set THREADLINES_CLI_ONLY=1",
      ...(launch.threadlinesHome === null
        ? []
        : [`set "THREADLINES_HOME=${launch.threadlinesHome.replaceAll("%", "%%")}"`]),
      `${batchQuote(launch.executablePath)} ${batchQuote(launch.entryPath)} %*`,
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
  }
  const home =
    launch.threadlinesHome === null
      ? []
      : [`export THREADLINES_HOME=${shellQuote(launch.threadlinesHome)}`];
  if (launch.appImagePath !== null) {
    return [
      "#!/bin/sh",
      `# ${HEADER}`,
      ...home,
      `export ${APPIMAGE_COMMAND_ENV}=1`,
      `exec ${shellQuote(launch.appImagePath)} ${APPIMAGE_COMMAND_FLAG} "$@"`,
      "",
    ].join("\n");
  }
  return [
    "#!/bin/sh",
    `# ${HEADER}`,
    "export ELECTRON_RUN_AS_NODE=1",
    "export THREADLINES_CLI_ONLY=1",
    ...home,
    `exec ${shellQuote(launch.executablePath)} ${shellQuote(launch.entryPath)} "$@"`,
    "",
  ].join("\n");
}

/**
 * What is at the command's place: nothing, this app's script, or something
 * else (another copy of Threadlines, an older script, or npm's `threadlines`).
 */
export function classifyCliCommand(
  existing: string | null,
  expected: string,
): "not_installed" | "installed" | "other_copy" {
  if (existing === null) return "not_installed";
  return existing.replaceAll("\r\n", "\n") === expected.replaceAll("\r\n", "\n")
    ? "installed"
    : "other_copy";
}

const pathEntryKey = (entry: string, platform: NodeJS.Platform) => {
  const trimmed = entry.trim().replace(/^"+|"+$/gu, "");
  const withoutSlash = trimmed.length > 1 ? trimmed.replace(/[\\/]+$/u, "") : trimmed;
  return platform === "win32" ? withoutSlash.toLowerCase() : withoutSlash;
};

/** Whether `folder` is one of PATH's entries. */
export function isFolderOnPath(
  folder: string,
  pathValue: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  const key = pathEntryKey(folder, platform);
  return (pathValue ?? "")
    .split(platform === "win32" ? ";" : ":")
    .some((entry) => entry.trim().length > 0 && pathEntryKey(entry, platform) === key);
}

/** A Windows PATH value with `folder` added at the end or taken out, its other entries untouched. */
export function editWindowsPath(current: string, folder: string, action: "add" | "remove"): string {
  const entries = current.split(";").filter((entry) => entry.length > 0);
  const key = pathEntryKey(folder, "win32");
  const others = entries.filter((entry) => pathEntryKey(entry, "win32") !== key);
  if (action === "remove") return others.join(";");
  return others.length === entries.length ? [...entries, folder].join(";") : entries.join(";");
}

/**
 * Why Install isn't offered for this copy, or null. A macOS app run from its
 * disk image, or from where macOS put it after the download (App
 * Translocation), runs from a path that goes away.
 */
export function cliCommandUnavailableReason(input: {
  readonly platform: NodeJS.Platform;
  readonly executablePath: string;
}): string | null {
  if (
    input.platform === "darwin" &&
    (input.executablePath.includes("/AppTranslocation/") ||
      input.executablePath.startsWith("/Volumes/"))
  ) {
    return "Move Threadlines to your Applications folder and open it from there first.";
  }
  return null;
}

/** Dev builds: how to run the command from the repo instead of installing it. */
export function cliCommandDevCommand(input: {
  readonly rootDir: string;
  /** Null when it's the default `~/.threadlines`. */
  readonly threadlinesHome: string | null;
  readonly path: Path.Path;
}): string {
  const quote = (value: string) => (/\s/u.test(value) ? `"${value}"` : value);
  const entry = input.path.join(input.rootDir, "apps", "server", "src", "bin.ts");
  const home = input.threadlinesHome === null ? "" : ` --base-dir ${quote(input.threadlinesHome)}`;
  return `node ${quote(entry)} connect --dev${home}`;
}
