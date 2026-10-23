/**
 * The installed `threadlines` command in an AppImage build
 * (cliCommandScript.ts). An AppImage mounts somewhere new on every launch,
 * so its script can't name the app's executable or server bundle. It runs
 * the AppImage file with APPIMAGE_COMMAND_ENV set instead, and main.ts calls
 * this before anything else: the app's executable, from wherever it is
 * mounted now, runs the command as Node on the app's server bundle, and this
 * process exits with the command's code. The app itself never starts.
 */
import { spawnSync } from "node:child_process";
import * as NodePath from "node:path";

import { BACKEND_ENTRY_RELATIVE_PATH } from "../app/DesktopEnvironment.ts";
import { APPIMAGE_COMMAND_ENV, APPIMAGE_COMMAND_FLAG } from "./cliCommandScript.ts";

/** The command's own arguments: what follows the flag, past anything the AppImage launcher added. */
export function appImageCommandArgs(argv: ReadonlyArray<string>): ReadonlyArray<string> {
  const at = argv.indexOf(APPIMAGE_COMMAND_FLAG);
  return at === -1 ? [] : argv.slice(at + 1);
}

/** Runs the command and exits when the AppImage's script asked for it; otherwise returns. */
export function runAppImageCommandIfAsked(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly argv: ReadonlyArray<string>;
  readonly executablePath: string;
  /** `app.getAppPath()`: the packaged app, where the server bundle is. */
  readonly appPath: string;
}): void {
  if (input.env[APPIMAGE_COMMAND_ENV] !== "1") return;
  const { [APPIMAGE_COMMAND_ENV]: _asked, ...env } = input.env;
  const result = spawnSync(
    input.executablePath,
    [NodePath.join(input.appPath, BACKEND_ENTRY_RELATIVE_PATH), ...appImageCommandArgs(input.argv)],
    { stdio: "inherit", env: { ...env, ELECTRON_RUN_AS_NODE: "1", THREADLINES_CLI_ONLY: "1" } },
  );
  process.exit(result.status ?? 1);
}
