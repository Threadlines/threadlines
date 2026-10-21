/**
 * Imported first by both entries (`bin.ts` from source, `launcher.ts` in the
 * published build), so it runs before any other module loads: every program
 * the server starts must see the user's environment as it was.
 */
import { stopWorkingFolderCommandLookup } from "@threadlines/shared/windowsCommandLookup";

/**
 * - On Windows, stops command lookups in the working folder: a project's own
 *   `git.exe` must never stand in for git. The Claude SDK sets the same
 *   variable while it loads (@threadlines/shared/windowsCommandLookup).
 * - Drops `ELECTRON_RUN_AS_NODE`. The desktop app sets it to run this server
 *   on Electron's Node, and Electron reads it only at launch. Left in place,
 *   every agent, terminal and editor the server starts inherits it, and any
 *   Electron app run from them (VS Code, Slack, a project's own app) starts as
 *   plain Node instead. A child that is meant to be Electron running as Node
 *   sets it itself (DictationEngine).
 */
export function prepareStartupEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  stopWorkingFolderCommandLookup(env, platform);
  delete env.ELECTRON_RUN_AS_NODE;
}

prepareStartupEnvironment();
