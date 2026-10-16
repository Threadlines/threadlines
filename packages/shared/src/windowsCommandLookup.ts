/**
 * Windows looks for a bare command such as `git` in the working folder before
 * PATH: Node's spawn (libuv), CreateProcess and cmd.exe all do. Threadlines
 * runs git, gh and agent CLIs inside project folders, so a project holding its
 * own `git.exe` would have it run on the next status refresh, before anyone
 * asked an agent to do anything.
 *
 * Windows skips the working folder while `NoDefaultCurrentDirectoryInExePath`
 * exists in the environment of the process doing the lookup; its value is
 * ignored. The server sets it on itself at startup, which covers every lookup
 * it makes. The programs it starts get the environment the user had back
 * ({@link withUsualCommandLookup}), so agents, terminals, git hooks and editors
 * find programs exactly as they do outside Threadlines. The exception is
 * cmd.exe started to run a command for the server: it does that lookup
 * itself, so it keeps the variable.
 */

export const WORKING_FOLDER_LOOKUP_VARIABLE = "NoDefaultCurrentDirectoryInExePath";

/**
 * Set beside the variable when the server added it. The value can't say so:
 * the Claude SDK sets the variable to "1" itself while loading.
 */
export const SERVER_ADDED_VARIABLE = "THREADLINES_ADDED_NO_CWD_LOOKUP";

/** Windows variable names ignore case, and a spread of `process.env` keeps the user's casing. */
function hasName(name: string, expected: string): boolean {
  return name.toUpperCase() === expected.toUpperCase();
}

/**
 * Stops Windows from looking in the working folder for the commands this
 * process starts. Leaves a variable the user set alone. Call it before
 * anything else loads; it applies to lookups made after it.
 */
export function stopWorkingFolderCommandLookup(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") return;
  if (Object.keys(env).some((name) => hasName(name, WORKING_FOLDER_LOOKUP_VARIABLE))) return;
  env[WORKING_FOLDER_LOOKUP_VARIABLE] = "1";
  env[SERVER_ADDED_VARIABLE] = "1";
}

/**
 * The environment for a program the server starts: `env` without the
 * variable when the server added it, so the program and everything it runs
 * look up commands as they would outside Threadlines. Returns `env` itself
 * when there is nothing to remove and never changes it.
 */
export function withUsualCommandLookup<Env extends Readonly<Record<string, string | undefined>>>(
  env: Env,
): Env {
  if (!Object.keys(env).some((name) => hasName(name, SERVER_ADDED_VARIABLE))) return env;
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        !hasName(name, WORKING_FOLDER_LOOKUP_VARIABLE) && !hasName(name, SERVER_ADDED_VARIABLE),
    ),
  ) as Env;
}
