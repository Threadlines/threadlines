// @effect-diagnostics nodeBuiltinImport:off
import { existsSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

/**
 * Extensions that name a Windows batch shim rather than a real executable.
 * These can only run through `cmd.exe`, so they force `shell: true`.
 */
const WINDOWS_BATCH_EXTENSIONS = new Set([".cmd", ".bat"]);

/**
 * Fallback `PATHEXT` (the Windows default) used when the environment does not
 * provide one. Order matters: it mirrors how the OS picks an extension for a
 * bare command name.
 */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

interface ResolveOptions {
  readonly platform?: NodeJS.Platform;
  /** Injection point for tests; defaults to `fs.existsSync`. */
  readonly exists?: (path: string) => boolean;
}

/**
 * Resolve a command name/path to the concrete file Windows would execute,
 * searching `PATH` × `PATHEXT` for bare names. Returns `undefined` when nothing
 * matching exists on disk.
 */
function resolveWindowsCommandPath(
  command: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string | undefined {
  const hasExtension = extname(command).length > 0;
  const extensions = hasExtension
    ? [""]
    : (env.PATHEXT ?? DEFAULT_PATHEXT)
        .split(";")
        .map((ext) => ext.trim())
        .filter((ext) => ext.length > 0);
  const candidatesFor = (base: string): ReadonlyArray<string> =>
    extensions.map((ext) => base + ext);

  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return candidatesFor(resolve(command)).find((candidate) => exists(candidate));
  }

  const pathDirs = (env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);
  for (const dir of pathDirs) {
    const match = candidatesFor(join(dir, command)).find((candidate) => exists(candidate));
    if (match) return match;
  }
  return undefined;
}

/**
 * Decide whether spawning `command` must go through a shell.
 *
 * Background: on Windows, Node builds a single `cmd.exe` command line by
 * concatenating argv when `shell: true`, and it does **not** escape the
 * arguments (Node deprecation DEP0190). That corrupts any argument containing
 * quotes — e.g. the inline JSON we hand to `claude --json-schema '{…}'`, which
 * arrives at the CLI as invalid JSON. Spawning a native executable directly
 * (`shell: false`) forwards argv verbatim and keeps the JSON intact.
 *
 * Batch shims (`.cmd`/`.bat`) are not real executables and can only run via
 * `cmd.exe`, so those still require a shell. We therefore resolve the command
 * and only request a shell when it points at a batch shim. On non-Windows
 * platforms argv is always passed verbatim, so no shell is ever needed.
 */
export function cliSpawnNeedsShell(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return false;

  const exists = options.exists ?? existsSync;
  const resolved = resolveWindowsCommandPath(command, env, exists);
  const extension = extname(resolved ?? command).toLowerCase();
  return WINDOWS_BATCH_EXTENSIONS.has(extension);
}
