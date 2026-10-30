/**
 * ExternalLauncher - external application launch service interface.
 *
 * Owns process launch helpers for browser URLs and workspace paths
 * in configured editor integrations.
 *
 * @module ExternalLauncher
 */
import {
  EDITORS,
  ExternalLauncherError,
  type EditorId,
  type LaunchEditorInput,
} from "@threadlines/contracts";
import { hideWindowsConsole } from "@threadlines/shared/childProcess";
import { areFilesystemPathsEqual, isFilesystemPathWithin } from "@threadlines/shared/path";
import {
  isCommandAvailable,
  makeCommandPathResolver,
  resolveCommandPath,
  type CommandPathResolver,
} from "@threadlines/shared/shell";
import { withUsualCommandLookup } from "@threadlines/shared/windowsCommandLookup";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// ==============================
// Definitions
// ==============================

export { ExternalLauncherError };
export type { LaunchEditorInput };
export { isCommandAvailable } from "@threadlines/shared/shell";

interface EditorLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell?: boolean;
  readonly windowsHide?: boolean;
  /**
   * Windows: the args are already quoted the way the program reads them and
   * go on its command line as written. Node's own quoting would wrap an arg
   * with a space in it whole and leave one with only a comma bare.
   */
  readonly verbatimArgs?: boolean;
  /**
   * Launched instead when this command fails. A launch with a fallback is a
   * quick request rather than an app: it runs attached, and the fallback
   * starts only when it is missing or exits with an error within
   * {@link ATTACHED_LAUNCH_WAIT}.
   */
  readonly fallback?: EditorLaunch;
}

/**
 * How long a request with a fallback is waited on. One still running then is
 * left to finish on its own and counts as answered: a file manager slow to
 * start may still show the file, and falling back would open a second window.
 */
const ATTACHED_LAUNCH_WAIT = "5 seconds";

/**
 * Asks the desktop's file manager to show a file with it selected, over the
 * freedesktop FileManager1 D-Bus interface (Nautilus, Dolphin, Nemo, Caja and
 * others answer it). `--print-reply` makes dbus-send fail when nothing does.
 */
function resolveShowItemsArgs(filePath: string): ReadonlyArray<string> {
  // dbus-send splits array values on commas, so a comma in the name is
  // percent-encoded like the rest of the URI.
  const fileUri = pathToFileURL(filePath).href.replaceAll(",", "%2C");
  // The reply timeout outlasts ATTACHED_LAUNCH_WAIT, so a slow answer is
  // never mistaken for a failure.
  return [
    "--session",
    "--print-reply",
    "--reply-timeout=20000",
    "--dest=org.freedesktop.FileManager1",
    "--type=method_call",
    "/org/freedesktop/FileManager1",
    "org.freedesktop.FileManager1.ShowItems",
    `array:string:${fileUri}`,
    "string:",
  ];
}

interface ProcessLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.CommandOptions;
  readonly windowsHide?: boolean;
}

interface TargetPathAndPosition {
  readonly path: string;
  readonly line: string;
  readonly column: Option.Option<string>;
}

const TARGET_WITH_POSITION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;
const POWERSHELL_ARGUMENTS_PREFIX = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
] as const;

const DETACHED_IGNORE_STDIO_OPTIONS = {
  detached: true,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
} as const satisfies ChildProcess.CommandOptions;

function parseTargetPathAndPosition(target: string): Option.Option<TargetPathAndPosition> {
  const match = TARGET_WITH_POSITION_PATTERN.exec(target);
  if (!match?.[1] || !match[2]) {
    return Option.none();
  }

  return Option.some({
    path: match[1],
    line: match[2],
    column: Option.fromUndefinedOr(match[3]),
  });
}

function resolveCommandEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const parsedTarget = parseTargetPathAndPosition(target);

  switch (editor.launchStyle) {
    case "direct-path":
      return [target];
    case "goto":
      return Option.isSome(parsedTarget) ? ["--goto", target] : [target];
    case "line-column":
      return Option.match(parsedTarget, {
        onNone: () => [target],
        onSome: ({ path, line, column }) => [
          "--line",
          line,
          ...Option.match(column, {
            onNone: () => [],
            onSome: (value) => ["--column", value],
          }),
          path,
        ],
      });
  }
}

/**
 * Every command editor takes a folder ahead of a file: VS Code and its forks
 * open the file in the window already showing that folder (or a new window
 * for it), Zed opens both as one workspace, and JetBrains IDEs open the
 * project before the file so it lands there rather than in LightEdit.
 */
function resolveEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
  folder: Option.Option<string>,
): ReadonlyArray<string> {
  const baseArgs = "baseArgs" in editor ? editor.baseArgs : [];
  return [...baseArgs, ...Option.toArray(folder), ...resolveCommandEditorArgs(editor, target)];
}

function isStrictlyWithin(path: string, root: string): boolean {
  return isFilesystemPathWithin(path, root) && !areFilesystemPathsEqual(path, root);
}

/**
 * The folder to open a file target in: the given workspace root, when the
 * target is a file (or not created yet) strictly inside it and the root is a
 * folder that exists. Folder targets open on their own, as before. Paths are
 * compared resolved (so `root/../other` is outside) and, failing that, with
 * symlinks followed (so `/tmp/p/a.ts` is inside `/private/tmp/p`).
 */
function resolveTargetFolder(
  target: string,
  workspaceRoot: string | undefined,
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    if (workspaceRoot === undefined) return Option.none();
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const targetPath = path.resolve(stripTargetPosition(target));
    const rootPath = path.resolve(workspaceRoot);
    if ((yield* statTargetType(rootPath)) !== "directory") return Option.none();
    if ((yield* statTargetType(targetPath)) === "directory") return Option.none();
    if (!isStrictlyWithin(targetPath, rootPath)) {
      const realPath = (value: string) =>
        fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));
      if (!isStrictlyWithin(yield* realPath(targetPath), yield* realPath(rootPath))) {
        return Option.none();
      }
    }
    return Option.some(rootPath);
  });
}

/**
 * The folders macOS apps are installed in. Pass them to the editor lookups
 * below so an editor whose command is not on PATH is still found in its app.
 */
export function macApplicationDirs(env: NodeJS.ProcessEnv = process.env): ReadonlyArray<string> {
  return ["/Applications", ...(env.HOME ? [`${env.HOME.replace(/\/+$/, "")}/Applications`] : [])];
}

/** An editor's commands, then on macOS the same tools inside its app. */
function editorCommandCandidates(
  editor: (typeof EDITORS)[number],
  platform: NodeJS.Platform,
  applicationDirs: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const commands = editor.commands ?? [fileManagerCommandForPlatform(platform)];
  if (platform !== "darwin" || !("macAppCommands" in editor)) return commands;
  return [
    ...commands,
    ...applicationDirs.flatMap((dir) => editor.macAppCommands.map((app) => `${dir}/${app}`)),
  ];
}

function resolveAvailableCommand(
  commands: ReadonlyArray<string>,
  resolveCommand: CommandPathResolver,
): Option.Option<string> {
  for (const command of commands) {
    if (resolveCommand(command) !== null) {
      return Option.some(command);
    }
  }
  return Option.none();
}

function encodeUtf16LeBase64(input: string): string {
  const bytes = new Uint8Array(input.length * 2);
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = code >>> 8;
  }
  return Base64.encode(bytes);
}

function escapePowerShellStringLiteral(input: string): string {
  return `'${input.replaceAll("'", "''")}'`;
}

function resolvePowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  return `${env.SYSTEMROOT || env.windir || String.raw`C:\Windows`}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function resolveWindowsExplorerPath(env: NodeJS.ProcessEnv = process.env): string {
  return `${env.SYSTEMROOT || env.windir || String.raw`C:\Windows`}\\explorer.exe`;
}

function resolveWslPowerShellPath(): string {
  return "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
}

function shouldUseWindowsBrowserFromWsl(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    platform === "linux" &&
    (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) &&
    env.SSH_CONNECTION === undefined &&
    env.SSH_TTY === undefined &&
    env.container === undefined
  );
}

/**
 * PowerShell's `Start`, which hands the URL to the default browser.
 *
 * On Windows itself it is not detached: Node starts a detached child with no
 * console at all, and PowerShell then exits without running anything (seen on
 * a real PC: the page never opened). Hidden instead, it gets a console of its
 * own with no window. A child that isn't detached ends with the Node process
 * that started it, so a caller must outlive `Start`, about a second; server
 * startup and `threadlines connect` do by far. From WSL the process is Linux's,
 * and detaching it only leaves the terminal's session.
 */
function resolveWindowsBrowserLaunch(
  target: string,
  command: string,
  from: "windows" | "wsl",
): ProcessLaunch {
  const encodedCommand = encodeUtf16LeBase64(
    `$ProgressPreference = 'SilentlyContinue'; Start ${escapePowerShellStringLiteral(target)}`,
  );
  return {
    command,
    args: [...POWERSHELL_ARGUMENTS_PREFIX, encodedCommand],
    options: {
      detached: from === "wsl",
      shell: false,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  };
}

function stripTargetPosition(target: string): string {
  const parsedTarget = parseTargetPathAndPosition(target);
  return Option.isSome(parsedTarget) ? parsedTarget.value.path : target;
}

function statTargetType(
  target: string,
): Effect.Effect<"directory" | "file" | "missing", never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stat = yield* fileSystem.stat(target).pipe(Effect.catch(() => Effect.succeed(null)));
    if (stat?.type === "Directory") return "directory";
    if (stat?.type === "File") return "file";
    return "missing";
  });
}

function resolveNearestExistingDirectory(
  target: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    let parent = path.dirname(target);

    while (parent && parent !== "." && parent !== target) {
      if ((yield* statTargetType(parent)) === "directory") {
        return parent;
      }

      const nextParent = path.dirname(parent);
      if (!nextParent || nextParent === parent) {
        return null;
      }
      parent = nextParent;
    }

    return null;
  });
}

/**
 * Explorer parses its own command line: a comma splits it as a space does,
 * and only double quotes keep a path whole. As Node quotes args,
 * `/select,C:\a b.pdf` arrives wrapped whole and `C:\x\a,b.pdf` bare, and
 * Explorer shows the wrong folder, usually Documents. A Windows path cannot
 * contain `"`, so wrapping it is all the quoting needed.
 */
function quoteExplorerPath(path: string): string {
  return `"${path}"`;
}

const resolveWindowsFileManagerLaunch = Effect.fn("resolveWindowsFileManagerLaunch")(function* (
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<EditorLaunch, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const normalizedTarget = path.normalize(target);
  const targetType = yield* statTargetType(normalizedTarget);
  const args =
    targetType === "file"
      ? [`/select,${quoteExplorerPath(normalizedTarget)}`]
      : [
          quoteExplorerPath(
            targetType === "directory"
              ? normalizedTarget
              : ((yield* resolveNearestExistingDirectory(normalizedTarget)) ?? normalizedTarget),
          ),
        ];

  return {
    command: resolveWindowsExplorerPath(env),
    args,
    shell: false,
    verbatimArgs: true,
    // `windowsHide` maps to SW_HIDE for GUI processes in libuv. Explorer
    // starts successfully in that state but never presents its window.
    windowsHide: false,
  };
});

function fileManagerCommandForPlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default:
      return "xdg-open";
  }
}

const resolveFileManagerLaunch = Effect.fn("resolveFileManagerLaunch")(function* (
  target: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<EditorLaunch, never, FileSystem.FileSystem | Path.Path> {
  const openTarget = stripTargetPosition(target);
  if (platform === "win32") {
    return yield* resolveWindowsFileManagerLaunch(openTarget, env);
  }

  // File targets reveal in the file manager (matching Windows' `/select`)
  // instead of launching the default application for the file type: `open -R`
  // on macOS; on Linux the file manager is asked over D-Bus to select it, and
  // the containing directory opens when none answers (xdg-open cannot select).
  const targetType = yield* statTargetType(openTarget);
  if (targetType === "file" && platform === "darwin") {
    return { command: "open", args: ["-R", openTarget] };
  }
  const path = yield* Path.Path;
  const openFolder = {
    command: fileManagerCommandForPlatform(platform),
    args: [targetType === "file" ? path.dirname(openTarget) : openTarget],
  };
  if (targetType === "file" && makeCommandPathResolver({ platform, env })("dbus-send") !== null) {
    return { command: "dbus-send", args: resolveShowItemsArgs(openTarget), fallback: openFolder };
  }
  return openFolder;
});

export function resolveBrowserLaunch(
  target: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ProcessLaunch {
  if (platform === "darwin") {
    return {
      command: "open",
      args: [target],
      options: DETACHED_IGNORE_STDIO_OPTIONS,
    };
  }

  if (platform === "win32") {
    return resolveWindowsBrowserLaunch(target, resolvePowerShellPath(env), "windows");
  }

  if (shouldUseWindowsBrowserFromWsl(platform, env)) {
    return resolveWindowsBrowserLaunch(target, resolveWslPowerShellPath(), "wsl");
  }

  return {
    command: "xdg-open",
    args: [target],
    options: DETACHED_IGNORE_STDIO_OPTIONS,
  };
}

/**
 * The editors installed on this machine. `applicationDirs` are where to look
 * for macOS apps (see {@link macApplicationDirs}); left empty, only PATH is
 * searched.
 */
export function resolveAvailableEditors(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  applicationDirs: ReadonlyArray<string> = [],
): ReadonlyArray<EditorId> {
  // Runs on every server config load; one resolver lists each PATH directory
  // once for the whole editor list.
  const resolveCommand = makeCommandPathResolver({ platform, env });
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    const commands = editorCommandCandidates(editor, platform, applicationDirs);
    if (Option.isSome(resolveAvailableCommand(commands, resolveCommand))) {
      available.push(editor.id);
    }
  }

  return available;
}

/**
 * ExternalLauncherShape - Service API for browser and editor launch actions.
 */
export interface ExternalLauncherShape {
  /**
   * Launch a URL target in the default browser.
   */
  readonly launchBrowser: (target: string) => Effect.Effect<void, ExternalLauncherError>;

  /**
   * Launch a workspace path in a selected editor integration.
   *
   * Launches the editor as a detached process so server startup is not blocked.
   */
  readonly launchEditor: (input: LaunchEditorInput) => Effect.Effect<void, ExternalLauncherError>;
}

/**
 * ExternalLauncher - Service tag for browser/editor launch operations.
 */
export class ExternalLauncher extends Context.Service<ExternalLauncher, ExternalLauncherShape>()(
  "threadlines/process/ExternalLauncher",
) {}

// ==============================
// Implementations
// ==============================

export const resolveEditorLaunch = Effect.fn("resolveEditorLaunch")(function* (
  input: LaunchEditorInput,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  applicationDirs: ReadonlyArray<string> = [],
): Effect.fn.Return<EditorLaunch, ExternalLauncherError, FileSystem.FileSystem | Path.Path> {
  yield* Effect.annotateCurrentSpan({
    "externalLauncher.editor": input.editor,
    "externalLauncher.cwd": input.cwd,
    "externalLauncher.platform": platform,
  });
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new ExternalLauncherError({ message: `Unknown editor: ${input.editor}` });
  }

  if (editorDef.commands) {
    const command = Option.getOrElse(
      resolveAvailableCommand(
        editorCommandCandidates(editorDef, platform, applicationDirs),
        makeCommandPathResolver({ platform, env }),
      ),
      () => editorDef.commands[0],
    );
    const folder = yield* resolveTargetFolder(input.cwd, input.workspaceRoot);
    return {
      command,
      args: resolveEditorArgs(editorDef, input.cwd, folder),
    };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new ExternalLauncherError({ message: `Unsupported editor: ${input.editor}` });
  }

  return yield* resolveFileManagerLaunch(input.cwd, platform, env);
});

const launchAndUnref = Effect.fn("externalLauncher.launchAndUnref")(function* (
  launch: ProcessLaunch,
  errorMessage: string,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(
    launch.command,
    launch.args,
    launch.windowsHide === false ? launch.options : hideWindowsConsole(launch.options),
  );

  yield* spawner.spawn(command).pipe(
    Effect.flatMap((handle) => handle.unref),
    Effect.asVoid,
    Effect.scoped,
    Effect.mapError((cause) => new ExternalLauncherError({ message: errorMessage, cause })),
  );
});

export const launchBrowser = Effect.fn("externalLauncher.launchBrowser")(function* (
  target: string,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  return yield* launchAndUnref(resolveBrowserLaunch(target), "Browser auto-open failed");
});

/**
 * Quotes one argument for a command line cmd.exe passes on to the editor.
 * Trailing backslashes are doubled so the editor's own parser does not read
 * `\"` as an escaped quote: a folder like `C:\` must not swallow what follows.
 */
export function quoteWindowsShellArg(arg: string): string {
  return `"${arg.replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * Runs a quick request: false when it is missing, cannot start, or exits with
 * an error within {@link ATTACHED_LAUNCH_WAIT}; true when it succeeds or is
 * still running then (it is let go, not killed).
 */
const runAttached = Effect.fn("externalLauncher.runAttached")(function* (
  launch: EditorLaunch,
): Effect.fn.Return<boolean, never, ChildProcessSpawner.ChildProcessSpawner> {
  if (!isCommandAvailable(launch.command)) return false;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(
    launch.command,
    launch.args,
    hideWindowsConsole({
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      forceKillAfter: "1 second",
    }),
  );
  return yield* spawner.spawn(command).pipe(
    Effect.flatMap((handle) =>
      handle.exitCode.pipe(
        Effect.timeoutOption(ATTACHED_LAUNCH_WAIT),
        Effect.flatMap((exited) =>
          Option.match(exited, {
            onSome: (exitCode) => Effect.succeed(exitCode === 0),
            onNone: () => Effect.as(handle.unref, true),
          }),
        ),
      ),
    ),
    Effect.scoped,
    Effect.orElseSucceed(() => false),
  );
});

/**
 * Starts a detached program with its args on the command line as written
 * (see {@link EditorLaunch.verbatimArgs}). Effect's process options have no
 * way to ask Node for that, so this launch goes to Node directly.
 */
function launchVerbatim(launch: EditorLaunch): Effect.Effect<void, ExternalLauncherError> {
  return Effect.callback<void, ExternalLauncherError>((resume) => {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: launch.windowsHide ?? true,
      windowsVerbatimArguments: true,
    });
    child.once("error", (cause) => {
      resume(
        Effect.fail(
          new ExternalLauncherError({ message: "failed to spawn detached process", cause }),
        ),
      );
    });
    child.once("spawn", () => {
      child.unref();
      resume(Effect.void);
    });
  });
}

export const launchEditorProcess = Effect.fn("externalLauncher.launchEditorProcess")(function* (
  launch: EditorLaunch,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  if (launch.fallback !== undefined) {
    if (yield* runAttached(launch)) return;
    return yield* launchEditorProcess(launch.fallback);
  }
  if (!isCommandAvailable(launch.command)) {
    return yield* new ExternalLauncherError({
      message: `Editor command not found: ${launch.command}`,
    });
  }
  if (launch.verbatimArgs === true) {
    return yield* launchVerbatim(launch);
  }

  const isWin32 = process.platform === "win32";
  const shell = isWin32 ? (launch.shell ?? true) : (launch.shell ?? false);
  // On Windows the editor starts from its place on PATH, never a same-named
  // file in the working folder, and with the user's own environment, so the
  // terminals inside it find programs as they would outside Threadlines.
  const command = isWin32 ? (resolveCommandPath(launch.command) ?? launch.command) : launch.command;
  yield* launchAndUnref(
    {
      command: isWin32 && shell ? `"${command}"` : command,
      args: isWin32 && shell ? launch.args.map(quoteWindowsShellArg) : [...launch.args],
      options: {
        detached: true,
        shell,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        ...(isWin32 ? { env: withUsualCommandLookup(process.env), extendEnv: false } : {}),
      },
      ...(launch.windowsHide !== undefined ? { windowsHide: launch.windowsHide } : {}),
    },
    "failed to spawn detached process",
  );
});

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return {
    launchBrowser: (target) =>
      launchBrowser(target).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    launchEditor: (input) =>
      Effect.flatMap(
        resolveEditorLaunch(input, process.platform, process.env, macApplicationDirs()).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
        (launch) =>
          launchEditorProcess(launch).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
      ),
  } satisfies ExternalLauncherShape;
});

export const layer = Layer.effect(ExternalLauncher, make);
