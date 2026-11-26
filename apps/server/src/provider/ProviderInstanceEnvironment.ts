import type { ProviderInstanceEnvironment } from "@threadlines/contracts";

/**
 * Re-reads the server's environment (PATH changes after an install) into an
 * instance's retained environment. `baseEnv` is what the instance started
 * from; an instance that started from a filtered copy must refresh from the
 * same filter, or the refresh would put back what it removed.
 */
export function refreshProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  target: NodeJS.ProcessEnv,
  baseEnv: NodeJS.ProcessEnv = process.env,
): void {
  Object.assign(target, mergeProviderInstanceEnvironment(environment, baseEnv));
}

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    setEnvVar(next, variable.name, variable.value);
  }
  return next;
}

/**
 * Removes environment variable entries matching `names` from a plain object
 * copy of an environment. On Windows, matches case-insensitively because
 * spreading `process.env` produces a case-sensitive JS object whose differently
 * cased keys (`anthropic_api_key`, `codex_sqlite_home`, etc.) are still treated
 * as the same variable by spawned child processes.
 */
export function deleteEnvVars(
  target: NodeJS.ProcessEnv,
  names: ReadonlyArray<string>,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") {
    for (const name of names) {
      delete target[name];
    }
    return;
  }
  const upperNames = new Set(names.map((name) => name.toUpperCase()));
  for (const key of Object.keys(target)) {
    if (upperNames.has(key.toUpperCase())) {
      delete target[key];
    }
  }
}

/**
 * Sets `target[name] = value`, clearing any differently cased copies on Windows
 * so child processes never see duplicate keys with conflicting values.
 */
export function setEnvVar(
  target: NodeJS.ProcessEnv,
  name: string,
  value: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") {
    deleteEnvVars(target, [name], platform);
  }
  target[name] = value;
}

/**
 * Reads an environment variable's value from a plain object, matching
 * case-insensitively on Windows.
 */
export function readEnvVar(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32") {
    return env[name];
  }
  if (env[name] !== undefined) return env[name];
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper) return value;
  }
  return undefined;
}

/**
 * The instance's own variables, names and values, as one comparable key: two
 * configurations with the same key start their agent with the same variables.
 */
export function providerInstanceEnvironmentKey(
  environment: ProviderInstanceEnvironment | undefined,
): string {
  return JSON.stringify((environment ?? []).map((variable) => [variable.name, variable.value]));
}
