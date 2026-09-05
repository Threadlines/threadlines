import type { ProviderInstanceEnvironment } from "@threadlines/contracts";

/** Refresh inherited PATH in the environment already held by a driver's runtimes. */
export function refreshProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  target: NodeJS.ProcessEnv,
): void {
  Object.assign(target, mergeProviderInstanceEnvironment(environment));
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
