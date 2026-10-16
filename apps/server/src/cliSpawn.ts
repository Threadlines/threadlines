// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync, statSync } from "node:fs";
import { win32 as WindowsPath } from "node:path";
import {
  defaultCommandFileSystem,
  makeCommandPathResolver,
  type CommandFileSystem,
} from "@threadlines/shared/shell";

/**
 * Extensions that name a Windows batch shim rather than a real executable.
 * These can only run through `cmd.exe`, so they force `shell: true`.
 */
const WINDOWS_BATCH_EXTENSIONS = new Set([".cmd", ".bat"]);

/** Extensions Windows starts without a shell. */
const WINDOWS_NATIVE_EXTENSIONS = new Set([".exe", ".com"]);

/** npm's launchers are a few hundred bytes; a bigger batch file is something else. */
const MAX_SHIM_BYTES = 4096;

export interface CliSpawnFileSystem extends CommandFileSystem {
  /** The file's text, or null when it is too big to be a launcher. Throws when unreadable. */
  readonly readSmallTextFile: (filePath: string) => string | null;
}

interface ResolveOptions {
  readonly platform?: NodeJS.Platform;
  /** Injection point for tests; defaults to the real filesystem. */
  readonly fileSystem?: CliSpawnFileSystem;
}

const defaultCliSpawnFileSystem: CliSpawnFileSystem = {
  ...defaultCommandFileSystem,
  readSmallTextFile: (filePath) =>
    statSync(filePath).size <= MAX_SHIM_BYTES ? readFileSync(filePath, "utf8") : null,
};

/**
 * The launcher npm writes for a Node CLI (`%AppData%\npm\codex.cmd`, made by
 * cmd-shim 5 through 9). It runs `node.exe` from its own folder when there is
 * one, else `node` found the way cmd.exe finds it: in the working folder
 * first. Only this exact text counts, apart from the script path and plain
 * node flags, so a launcher that sets variables or does anything else runs as
 * it is.
 */
const NPM_NODE_SHIM = new RegExp(
  [
    "^@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\\\node\\.exe" \\(',
    '  SET "_prog=%dp0%\\\\node\\.exe"',
    "\\) ELSE \\(",
    '  SET "_prog=node"',
    "(?:  SET PATHEXT=%PATHEXT:;\\.JS;=;%\\n)?\\)",
    "",
    "endLocal & goto #_undefined_# 2>NUL \\|\\| title %COMSPEC% & " +
      '(?:set PATHEXT=%PATHEXT:;\\.JS;=;% & )?"%_prog%" (?<flags>[^"%]*?) ?"%dp0%\\\\(?<script>[^"%]+)" %\\*$',
  ].join("\\n"),
  "u",
);

/** Node flags that npm copies from a script's `#!` line, such as `--no-warnings`. */
const PLAIN_NODE_FLAG = /^-[A-Za-z0-9_\-=.,:]+$/u;

interface NodeScriptLaunch {
  readonly node: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * What an npm launcher would run, so the server can start it directly: the
 * launcher's own `node` lookup would otherwise search the project folder. Null
 * for anything that isn't exactly npm's launcher of a script that exists.
 */
function readNpmNodeShim(
  shimPath: string,
  resolveCommand: (command: string) => string | null,
  fileSystem: CliSpawnFileSystem,
): NodeScriptLaunch | null {
  let text: string | null;
  try {
    text = fileSystem.readSmallTextFile(shimPath);
  } catch {
    return null;
  }
  const match = text?.replace(/\r\n/gu, "\n").replace(/\n$/u, "").match(NPM_NODE_SHIM);
  const script = match?.groups?.script;
  if (!match || !script) return null;
  const flags = (match.groups?.flags ?? "").split(" ").filter((flag) => flag.length > 0);
  if (!flags.every((flag) => PLAIN_NODE_FLAG.test(flag))) return null;

  const shimDir = WindowsPath.dirname(shimPath);
  const scriptPath = WindowsPath.join(shimDir, script);
  const besideShim = WindowsPath.join(shimDir, "node.exe");
  const node = isFile(fileSystem, besideShim) ? besideShim : resolveCommand("node");
  if (!isFile(fileSystem, scriptPath) || node === null) return null;
  // A `node.cmd` from a version manager needs cmd.exe again; leave those to the launcher.
  if (!WINDOWS_NATIVE_EXTENSIONS.has(WindowsPath.extname(node).toLowerCase())) return null;
  return { node, args: [...flags, scriptPath] };
}

function isFile(fileSystem: CommandFileSystem, filePath: string): boolean {
  try {
    return fileSystem.isFile(filePath);
  } catch {
    return false;
  }
}

/** Arguments that survive cmd.exe and CommandLineToArgvW without quoting. */
const WINDOWS_SHELL_SAFE_ARG = /^[A-Za-z0-9_\-+=.,:\\/@]+$/;

/**
 * Quote a single argument for a cmd.exe command line so the target program's
 * argv parser (CommandLineToArgvW) reconstructs it verbatim: backslashes
 * before a quote are doubled and the quote itself is backslash-escaped.
 * cmd.exe-only metacharacters (`%`, `!`) are not escapable inside quotes; the
 * CLI arguments composed here never rely on them.
 */
function quoteWindowsShellArg(arg: string): string {
  if (WINDOWS_SHELL_SAFE_ARG.test(arg)) return arg;
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

export interface CliSpawnPlan {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: { readonly shell?: true };
}

/**
 * Plan how to spawn a CLI so argv arrives intact on every platform, and so
 * Windows starts the program found on PATH rather than one in the working
 * folder (often a project) with the same name.
 *
 * Off Windows the command and argv pass through unchanged. On Windows the
 * command is resolved on PATH × PATHEXT and started by its full path:
 * - native executables spawn shell-less with argv passed verbatim;
 * - npm's launcher of a Node CLI starts node and the script directly, since
 *   the launcher would look `node` up in the working folder first;
 * - other batch shims (`.cmd`/`.bat`) can only run through cmd.exe, so the
 *   command line is composed here with explicit quoting and handed over as a
 *   single string, because Node's own `shell: true` argv handling
 *   concatenates arguments unescaped (deprecated as DEP0190).
 * A command that resolves to nothing is spawned as given: through cmd.exe when
 * it names a batch file, else without a shell.
 */
export function planCliSpawn(
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveOptions = {},
): CliSpawnPlan {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command, args, options: {} };

  const fileSystem = options.fileSystem ?? defaultCliSpawnFileSystem;
  const resolverFor = (pathEnv: NodeJS.ProcessEnv) =>
    makeCommandPathResolver({
      platform,
      env: pathEnv,
      ...(options.fileSystem ? { fileSystem: options.fileSystem } : {}),
    });
  const resolveCommand = resolverFor(env);
  // A command named with its extension means exactly that file, whatever PATHEXT lists.
  const extension = WindowsPath.extname(command);
  const resolved = extension
    ? resolverFor({ ...env, PATHEXT: extension })(command)
    : resolveCommand(command);
  const target = resolved ?? command;
  if (!WINDOWS_BATCH_EXTENSIONS.has(WindowsPath.extname(target).toLowerCase())) {
    return { command: target, args, options: {} };
  }
  const nodeScript =
    resolved === null ? null : readNpmNodeShim(resolved, resolveCommand, fileSystem);
  if (nodeScript !== null) {
    return { command: nodeScript.node, args: [...nodeScript.args, ...args], options: {} };
  }
  const commandLine = [quoteWindowsShellArg(target), ...args.map(quoteWindowsShellArg)].join(" ");
  return { command: commandLine, args: [], options: { shell: true } };
}
