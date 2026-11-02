import { ChildProcess } from "effect/process";

export type WindowsHiddenCommandOptions = ChildProcess.CommandOptions & {
  readonly windowsHide?: boolean | undefined;
};

export function hideWindowsConsole<Options extends ChildProcess.CommandOptions>(
  options: Options,
  platform: NodeJS.Platform = process.platform,
): Options {
  if (platform !== "win32") return options;
  return {
    ...options,
    windowsHide: true,
  } as Options;
}

/**
 * A command to start, through a shell when `options.shell` is set. Effect
 * refuses a shell together with separate arguments, so then the arguments go
 * into the command line, joined with spaces exactly as Node joins them for a
 * shell: callers still quote each word for that shell (cmd.exe on Windows).
 * Without a shell, the command and its arguments are passed as they are.
 */
export function makeCommandWithShell(
  command: string,
  args: ReadonlyArray<string>,
  options: ChildProcess.CommandOptions = {},
): ChildProcess.StandardCommand {
  return options.shell
    ? ChildProcess.make([command, ...args].join(" "), [], options)
    : ChildProcess.make(command, args, options);
}
