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
    next[variable.name] = variable.value;
  }
  return next;
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
