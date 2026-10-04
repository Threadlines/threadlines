import type { ProviderInstanceEnvironment } from "@threadlines/contracts";

/** Refresh inherited PATH in the environment already held by a driver's runtimes. */
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
