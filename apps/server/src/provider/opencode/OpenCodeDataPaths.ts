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
import { isAbsolute, join } from "node:path";

import { openCodeAccountEnvironment } from "@threadlines/shared/providerAuthCommands";

/** The home OpenCode's own `os.homedir()` resolves to in this environment. */
function environmentHome(environment: NodeJS.ProcessEnv): string {
  const home = process.platform === "win32" ? environment.USERPROFILE : environment.HOME;
  return home?.trim() || homedir();
}

/** OpenCode's own data folder for an environment without an account folder. */
export function openCodeDataFolder(environment: NodeJS.ProcessEnv): string {
  const dataHome =
    environment.XDG_DATA_HOME?.trim() || join(environmentHome(environment), ".local", "share");
  return join(dataHome, "opencode");
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
}): { readonly file: string } | { readonly folder: string } {
  const environment = {
    ...input.environment,
    ...openCodeAccountEnvironment({
      accountFolder: input.accountFolder,
      platform: process.platform,
    }),
  };
  const explicit = environment.OPENCODE_DB?.trim();
  const folder = openCodeDataFolder(environment);
  if (!explicit) return { folder };
  return { file: isAbsolute(explicit) ? explicit : join(folder, explicit) };
}
