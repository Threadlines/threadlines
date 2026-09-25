/**
 * Running Linux-only CLIs from a Windows host through WSL.
 *
 * Some agents (fx) ship no Windows binary. On Windows we run them inside the
 * default WSL distro: `wsl.exe -- bash -lc "<line>"` gives a login shell so
 * `~/.local/bin` is on PATH, stdio pipes straight through (JSON-RPC works
 * unchanged), and `wsl.exe` starts in the Windows cwd mapped to `/mnt/<drive>`.
 *
 * @module wsl
 */

export const WSL_EXECUTABLE = "wsl.exe";

/** Quote one word for the bash line inside `bash -lc`. */
export function bashWord(value: string): string {
  if (/^[A-Za-z0-9_./~:@%+=,-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** `wsl.exe -- bash -lc "<line>"`; the line runs verbatim in a login shell. */
export function wslShellCommand(line: string): {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
} {
  return { file: WSL_EXECUTABLE, args: ["--", "bash", "-lc", line] };
}

/** `wsl.exe -- bash -lc "<executable> <args>"` with each word quoted. */
export function wslCommand(
  executable: string,
  args: ReadonlyArray<string>,
): { readonly file: string; readonly args: ReadonlyArray<string> } {
  return wslShellCommand([executable, ...args].map(bashWord).join(" "));
}

/**
 * Windows passes only the variables `WSLENV` names into a WSL process. Adds
 * each of `names` that is set in `env` (flag `/u`: Windows to Linux only), so
 * a provider's own settings (an API key) reach the CLI inside the distro.
 */
export function withWslForwardedEnv(
  env: NodeJS.ProcessEnv,
  names: ReadonlyArray<string>,
): NodeJS.ProcessEnv {
  const forwarded = names.filter((name) => env[name] !== undefined && env[name] !== "");
  if (forwarded.length === 0) {
    return env;
  }
  const existing = (env.WSLENV ?? "").split(":").filter((entry) => entry.length > 0);
  const existingNames = new Set(existing.map((entry) => entry.split("/")[0]));
  const additions = forwarded.filter((name) => !existingNames.has(name)).map((name) => `${name}/u`);
  return { ...env, WSLENV: [...existing, ...additions].join(":") };
}

/** What to tell someone whose WSL can't run Linux commands yet. */
export const WSL_SETUP_HINT =
  "Run `wsl --install` in an administrator terminal, restart Windows, then try again.";

const WSL_LAUNCH_FAILURE =
  /Error code: Wsl\/|WSL_E_[A-Z_]+|no installed distributions|Subsystem for Linux (?:is not|has not been) (?:installed|enabled)/iu;

/**
 * wsl.exe reports its own failures (WSL not installed, no Linux distro) in
 * UTF-16 text ending with an `Error code: Wsl/...` line, and the requested
 * command never runs. Returns wsl.exe's first line for those, so callers can
 * say "WSL isn't ready" instead of misreading the output as the command's.
 */
export function describeWslLaunchFailure(output: string): string | undefined {
  const text = output.replaceAll("\u0000", "").trim();
  if (!WSL_LAUNCH_FAILURE.test(text)) {
    return undefined;
  }
  return text.split(/\r?\n/u)[0]?.trim() || "WSL could not start";
}

/**
 * Windows path → WSL mount path (`C:\Users\me` → `/mnt/c/Users/me`).
 * Paths that are not drive-rooted are returned unchanged.
 */
export function toWslPath(windowsPath: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/u.exec(windowsPath.trim());
  if (!match) {
    return windowsPath;
  }
  const [, drive, rest] = match;
  const normalized = rest!.replace(/\\/g, "/").replace(/\/+$/u, "");
  return `/mnt/${drive!.toLowerCase()}/${normalized}`;
}
