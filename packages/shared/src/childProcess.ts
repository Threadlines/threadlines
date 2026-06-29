import type { ChildProcess } from "effect/unstable/process";

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
