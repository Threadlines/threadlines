/**
 * OpenCodeDataPaths — where an OpenCode instance keeps its data.
 *
 * OpenCode 2 keeps its sign-ins and every session in one SQLite database. An
 * instance with an account folder points `OPENCODE_DB` into that folder; one
 * without shares the terminal's database under `$XDG_DATA_HOME/opencode`
 * (`~/.local/share/opencode` on every platform, from the home the process
 * sees).
 *
 * @module provider/opencode/OpenCodeDataPaths
 */
import { homedir } from "node:os";
import * as NodePath from "node:path";

import { openCodeAccountEnvironment } from "@threadlines/shared/providerAuthCommands";

import { expandHomePath } from "../../pathExpansion.ts";
import { readEnvVar, setEnvVar } from "../ProviderInstanceEnvironment.ts";

/** The home OpenCode's own `os.homedir()` resolves to in this environment. */
function environmentHome(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const home =
    platform === "win32"
      ? readEnvVar(environment, "USERPROFILE", platform)
      : readEnvVar(environment, "HOME", platform);
  return home?.trim() || homedir();
}

/** OpenCode's own data folder for an environment without an account folder. */
export function openCodeDataFolder(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const dataHome =
    readEnvVar(environment, "XDG_DATA_HOME", platform)?.trim() ||
    pathApi.join(environmentHome(environment, platform), ".local", "share");
  return pathApi.join(dataHome, "opencode");
}

/**
 * A database file in the data folder: `opencode.db` from a stable build,
 * `opencode-<channel>.db` from another channel's.
 */
export const OPENCODE_DATABASE_FILE_NAME = /^opencode(?:-[\w.-]+)?\.db$/u;

/**
 * Where an instance's OpenCode keeps its database: the file `OPENCODE_DB`
 * names (an account folder sets it), resolved against the data folder when
 * relative, else the data folder, whose {@link OPENCODE_DATABASE_FILE_NAME}
 * files are the channels' databases.
 */
export function openCodeDatabaseLocation(input: {
  readonly accountFolder: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): { readonly file: string } | { readonly folder: string } {
  const platform = input.platform ?? process.platform;
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const trimmedAccountFolder = input.accountFolder.trim();
  const accountFolder = trimmedAccountFolder ? expandHomePath(trimmedAccountFolder) : "";
  const environment: NodeJS.ProcessEnv = { ...input.environment };
  for (const [key, value] of Object.entries(
    openCodeAccountEnvironment({ accountFolder, platform }),
  )) {
    setEnvVar(environment, key, value, platform);
  }
  const explicit = readEnvVar(environment, "OPENCODE_DB", platform)?.trim();
  const folder = openCodeDataFolder(environment, platform);
  if (!explicit) return { folder };
  return { file: pathApi.isAbsolute(explicit) ? explicit : pathApi.join(folder, explicit) };
}
