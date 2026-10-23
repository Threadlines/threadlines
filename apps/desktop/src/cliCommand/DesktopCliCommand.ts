/**
 * DesktopCliCommand: the "Threadlines command" row in Settings › Connections
 * › Agents (docs/design/outside-agents.md, "Putting it on PATH"). Puts this
 * copy of the app's `threadlines` command on PATH, says whether it's there,
 * and takes it away again.
 *
 * - macOS: `/usr/local/bin/threadlines`, through the system's administrator
 *   prompt when that folder isn't the user's to write, as VS Code's "Install
 *   'code' command" does. Cancel changes nothing; Remove asks again.
 * - Windows: `%LOCALAPPDATA%\Threadlines\bin\threadlines.cmd`, with that
 *   folder added to the user's PATH (no administrator). New terminals see it.
 * - Linux: `~/.local/bin/threadlines`; the row says when that folder isn't on
 *   PATH. An AppImage build's script runs the AppImage file.
 * - Dev builds install nothing; the row says how to run it from the repo.
 *
 * The script (cliCommandScript.ts) is written into a folder given at make
 * time, so tests write into a temp folder. Only the administrator prompt and
 * the Windows registry are left to `CliCommandSystem`.
 */
import type { DesktopCliCommandResult, DesktopCliCommandStatus } from "@threadlines/contracts";
import { hideWindowsConsole } from "@threadlines/shared/childProcess";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  type CliCommandLaunch,
  classifyCliCommand,
  cliCommandDevCommand,
  cliCommandDirectory,
  cliCommandFileName,
  cliCommandUnavailableReason,
  editWindowsPath,
  isFolderOnPath,
  renderCliCommandScript,
  shellQuote,
} from "./cliCommandScript.ts";

export class CliCommandFailure extends Data.TaggedError("CliCommandFailure")<{
  readonly message: string;
}> {}

/** How the Windows user PATH is saved: `ExpandString` keeps `%USERPROFILE%` and the like. */
export interface WindowsUserPath {
  readonly value: string;
  readonly kind: "String" | "ExpandString";
}

/** What the command can't do through the file system alone. */
export interface CliCommandSystem {
  /** Runs a shell command as root through macOS's administrator prompt. */
  readonly runAsAdministrator: (
    shellCommand: string,
  ) => Effect.Effect<"done" | "cancelled", CliCommandFailure>;
  /** The user's PATH as saved (Windows), unexpanded; null when there's none yet. */
  readonly readUserPath: Effect.Effect<WindowsUserPath | null, CliCommandFailure>;
  /** Saves the user's PATH (Windows) and tells running programs it changed. */
  readonly writeUserPath: (path: WindowsUserPath) => Effect.Effect<void, CliCommandFailure>;
}

export interface CliCommandSetup {
  readonly platform: NodeJS.Platform;
  /** Where the command goes. */
  readonly directory: string;
  readonly launch: CliCommandLaunch;
  /** Set in dev builds, which install nothing. */
  readonly devCommand: string | null;
  /** Why this copy can't install it, or null. */
  readonly unavailableReason: string | null;
  /** PATH as this app has it (the login shell's, once the app read it). */
  readonly processPath: () => string | undefined;
}

export interface DesktopCliCommandShape {
  readonly status: Effect.Effect<DesktopCliCommandStatus>;
  readonly install: Effect.Effect<DesktopCliCommandResult>;
  readonly remove: Effect.Effect<DesktopCliCommandResult>;
}

export class DesktopCliCommand extends Context.Service<DesktopCliCommand, DesktopCliCommandShape>()(
  "threadlines/desktop/CliCommand",
) {}

const isPermissionDenied = (error: PlatformError.PlatformError) =>
  error.reason._tag === "PermissionDenied";

const describe = (error: PlatformError.PlatformError | CliCommandFailure) =>
  error._tag === "CliCommandFailure" ? error.message : error.reason.message;

/**
 * The shell command that installs `script` at `target` as root. The script
 * travels inside the command: copying it from a file the user can write
 * would let another process of theirs swap that file, while the password
 * prompt is up, for a link to a file only root may read. Root writes a new
 * file in the target folder and renames it into place, which replaces a
 * link (npm's `threadlines`) rather than writing through it.
 */
export function administratorInstallCommand(input: {
  readonly directory: string;
  readonly target: string;
  readonly script: string;
}): string {
  return [
    `/bin/mkdir -p ${shellQuote(input.directory)}`,
    `staged=$(/usr/bin/mktemp ${shellQuote(`${input.directory}/.threadlines.XXXXXX`)})`,
    `/usr/bin/printf '%s' ${shellQuote(input.script)} > "$staged"`,
    `/bin/chmod 755 "$staged"`,
    `/bin/mv -f "$staged" ${shellQuote(input.target)}`,
  ].join(" && ");
}

export const make = Effect.fn("desktop.cliCommand.make")(function* (
  setup: CliCommandSetup,
  system: CliCommandSystem,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(setup.directory, cliCommandFileName(setup.platform));
  const script = renderCliCommandScript(setup.launch);
  // One change at a time: a second click while the prompt is up waits.
  const lock = yield* Semaphore.make(1);

  const readExisting = fs.readFileString(target).pipe(
    Effect.map((contents): string | null => contents),
    // Something there that can't be read isn't this app's script either.
    Effect.catch((error) => Effect.succeed(error.reason._tag === "NotFound" ? null : "")),
  );

  const onProcessPath = () => isFolderOnPath(setup.directory, setup.processPath(), setup.platform);

  /**
   * Whether new terminals find the installed command. On Windows this app's
   * own PATH is from its launch, so a folder Install just added is read from
   * the saved user PATH.
   */
  const installedFolderOnPath = Effect.gen(function* () {
    if (onProcessPath() || setup.platform !== "win32") return onProcessPath();
    const saved = yield* system.readUserPath.pipe(Effect.orElseSucceed(() => null));
    return isFolderOnPath(setup.directory, saved?.value, "win32");
  });

  const status: Effect.Effect<DesktopCliCommandStatus> = Effect.gen(function* () {
    const base = { path: target, folderOnPath: onProcessPath() };
    if (setup.devCommand !== null) {
      return { ...base, state: "unavailable", reason: null, devCommand: setup.devCommand } as const;
    }
    if (setup.unavailableReason !== null) {
      return {
        ...base,
        state: "unavailable",
        reason: setup.unavailableReason,
        devCommand: null,
      } as const;
    }
    const state = classifyCliCommand(yield* readExisting, script);
    const folderOnPath = state === "installed" ? yield* installedFolderOnPath : base.folderOnPath;
    return { ...base, folderOnPath, state, reason: null, devCommand: null };
  });

  /** The Windows user PATH with the command's folder added or taken out. */
  const editUserPath = (action: "add" | "remove") =>
    Effect.gen(function* () {
      if (setup.platform !== "win32") return;
      const saved = yield* system.readUserPath;
      const current = saved?.value ?? "";
      const next = editWindowsPath(current, setup.directory, action);
      if (next === current) return;
      yield* system.writeUserPath({ value: next, kind: saved?.kind ?? "ExpandString" });
    });

  /** Writes the script as the user; PermissionDenied when the folder isn't theirs. */
  const writeAsUser = Effect.gen(function* () {
    yield* fs.makeDirectory(setup.directory, { recursive: true });
    // A link (npm's `threadlines`) is replaced, never written through.
    yield* fs.remove(target, { force: true });
    yield* fs.writeFileString(target, script, { mode: 0o755 });
    yield* fs.chmod(target, 0o755);
  });

  const writeAsAdministrator = system.runAsAdministrator(
    administratorInstallCommand({ directory: setup.directory, target, script }),
  );

  const finish = (outcome: DesktopCliCommandResult["outcome"], detail: string | null) =>
    status.pipe(Effect.map((current) => ({ outcome, detail, status: current })));

  const unavailable = Effect.gen(function* () {
    const current = yield* status;
    return current.state === "unavailable"
      ? { outcome: "failed" as const, detail: current.reason, status: current }
      : null;
  });

  const install: Effect.Effect<DesktopCliCommandResult> = Effect.gen(function* () {
    const refused = yield* unavailable;
    if (refused !== null) return refused;
    const written = yield* writeAsUser.pipe(
      Effect.as("done" as const),
      Effect.catchIf(
        (error) => setup.platform === "darwin" && isPermissionDenied(error),
        () => writeAsAdministrator,
      ),
    );
    if (written === "cancelled") return yield* finish("cancelled", null);
    yield* editUserPath("add");
    return yield* finish("done", null);
  }).pipe(
    Effect.catch((error) => finish("failed", `Couldn't install it: ${describe(error)}`)),
    lock.withPermits(1),
  );

  const remove: Effect.Effect<DesktopCliCommandResult> = Effect.gen(function* () {
    const current = yield* status;
    if (current.state !== "installed") {
      return {
        outcome: "failed" as const,
        detail: "There's no command from this copy of Threadlines to remove.",
        status: current,
      };
    }
    const removed = yield* fs.remove(target, { force: true }).pipe(
      Effect.as("done" as const),
      Effect.catchIf(
        (error) => setup.platform === "darwin" && isPermissionDenied(error),
        () => system.runAsAdministrator(`/bin/rm -f ${shellQuote(target)}`),
      ),
    );
    if (removed === "cancelled") return yield* finish("cancelled", null);
    yield* editUserPath("remove");
    return yield* finish("done", null);
  }).pipe(
    Effect.catch((error) => finish("failed", `Couldn't remove it: ${describe(error)}`)),
    lock.withPermits(1),
  );

  return DesktopCliCommand.of({ status, install, remove });
});

// ----- the system: the administrator prompt and the Windows registry ---------------

/** A finished program's exit code and output. */
const runProgram = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>,
  env?: Record<string, string>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          command,
          args,
          hideWindowsConsole({
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            ...(env === undefined ? {} : { env, extendEnv: true }),
          }),
        ),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, exitCode: exitCode as number };
    }),
  ).pipe(
    Effect.mapError(
      (error) => new CliCommandFailure({ message: `${command} didn't run: ${error.message}` }),
    ),
  );

/** An AppleScript string literal. */
const appleScriptString = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;

/** macOS's administrator prompt names who asks with this line. */
const ADMINISTRATOR_PROMPT =
  "Threadlines wants to change the threadlines command in /usr/local/bin.";

/**
 * The AppleScript that runs `shellCommand` through `/bin/sh`: as root,
 * behind the system's password prompt, when `administrator`.
 */
export const doShellScript = (shellCommand: string, administrator: boolean) =>
  administrator
    ? `do shell script ${appleScriptString(shellCommand)} with prompt ${appleScriptString(ADMINISTRATOR_PROMPT)} with administrator privileges`
    : `do shell script ${appleScriptString(shellCommand)}`;

const decodeWindowsUserPathJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      value: Schema.NullOr(Schema.String),
      kind: Schema.String,
    }),
  ),
);

/**
 * READ_USER_PATH's answer. It comes as base64 of UTF-8: PowerShell writes
 * to a pipe in the console's code page, which would turn `C:\Tools\café`
 * into something else, and the edit would save that back.
 */
export const decodeWindowsUserPath = (stdout: string) =>
  decodeWindowsUserPathJson(Buffer.from(stdout.trim(), "base64").toString("utf8")).pipe(
    Effect.mapError(
      () => new CliCommandFailure({ message: "Couldn't read your PATH from Windows." }),
    ),
    Effect.flatMap((saved) => {
      if (saved.kind !== "String" && saved.kind !== "ExpandString") {
        return Effect.fail(
          new CliCommandFailure({
            message: "Your PATH is saved in a form Threadlines won't edit.",
          }),
        );
      }
      return Effect.succeed(
        saved.value === null ? null : ({ value: saved.value, kind: saved.kind } as const),
      );
    }),
  );

/** PowerShell from System32, given its script encoded so nothing in it needs quoting. */
const runPowerShell = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  script: string,
  env?: Record<string, string>,
) =>
  runProgram(
    spawner,
    `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    env,
  );

const READ_USER_PATH = `
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
$value = $null
$kind = 'ExpandString'
if ($key -ne $null -and ($key.GetValueNames() -contains 'Path')) {
  $value = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind = [string]$key.GetValueKind('Path')
}
$json = @{ value = $value; kind = $kind } | ConvertTo-Json -Compress
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
`;

// Setting any user variable through .NET broadcasts WM_SETTINGCHANGE, so
// Explorer, and the terminals it starts from now on, see the new PATH.
const WRITE_USER_PATH = `
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
$key.SetValue('Path', $env:THREADLINES_USER_PATH, [Microsoft.Win32.RegistryValueKind]$env:THREADLINES_USER_PATH_KIND)
$key.Close()
[Environment]::SetEnvironmentVariable('THREADLINES_PATH_CHANGED', '1', 'User')
[Environment]::SetEnvironmentVariable('THREADLINES_PATH_CHANGED', $null, 'User')
`;

export const makeSystem = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): CliCommandSystem => ({
  runAsAdministrator: (shellCommand) =>
    runProgram(spawner, "/usr/bin/osascript", ["-e", doShellScript(shellCommand, true)]).pipe(
      Effect.flatMap(({ exitCode, stderr }) => {
        if (exitCode === 0) return Effect.succeed("done" as const);
        // -128 is AppleScript's "User canceled."
        if (stderr.includes("-128")) return Effect.succeed("cancelled" as const);
        return Effect.fail(
          new CliCommandFailure({ message: stderr.trim() || `osascript exited ${exitCode}` }),
        );
      }),
    ),
  readUserPath: runPowerShell(spawner, READ_USER_PATH).pipe(
    Effect.flatMap(({ exitCode, stdout, stderr }) =>
      exitCode === 0
        ? decodeWindowsUserPath(stdout)
        : Effect.fail(
            new CliCommandFailure({ message: stderr.trim() || "Couldn't read your PATH." }),
          ),
    ),
  ),
  writeUserPath: (userPath) =>
    runPowerShell(spawner, WRITE_USER_PATH, {
      THREADLINES_USER_PATH: userPath.value,
      THREADLINES_USER_PATH_KIND: userPath.kind,
    }).pipe(
      Effect.flatMap(({ exitCode, stderr }) =>
        exitCode === 0
          ? Effect.void
          : Effect.fail(
              new CliCommandFailure({ message: stderr.trim() || "Couldn't change your PATH." }),
            ),
      ),
    ),
});

export const layer = Layer.effect(
  DesktopCliCommand,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { platform, path } = environment;
    const threadlinesHome = DesktopEnvironment.usesDefaultBaseDir(environment)
      ? null
      : environment.baseDir;
    const executablePath = process.execPath;
    return yield* make(
      {
        platform,
        directory: cliCommandDirectory({
          platform,
          homeDirectory: environment.homeDirectory,
          localAppData: process.env.LOCALAPPDATA,
          path,
        }),
        launch: {
          platform,
          executablePath,
          entryPath: environment.backendEntryPath,
          threadlinesHome,
          appImagePath: platform === "linux" ? process.env.APPIMAGE?.trim() || null : null,
        },
        devCommand: environment.isDevelopment
          ? cliCommandDevCommand({
              platform,
              rootDir: environment.rootDir,
              threadlinesHome,
              path,
            })
          : null,
        unavailableReason: cliCommandUnavailableReason({ platform, executablePath }),
        processPath: () => process.env.PATH ?? process.env.Path,
      },
      makeSystem(spawner),
    );
  }),
);
