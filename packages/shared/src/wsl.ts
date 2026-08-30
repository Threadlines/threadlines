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
