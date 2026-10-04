import type {
  AntigravityAuthMethod,
  ProviderInstanceConfig,
  ProviderInstanceEnvironmentVariable,
} from "@threadlines/contracts";
import {
  antigravityAuthMethodInfo,
  antigravityMissingSetup,
  type AntigravitySignInSetup,
  readAntigravitySignInSetup,
} from "@threadlines/shared/antigravitySignIn";

/** What the Account tab's method choice holds before it is saved. */
export interface AntigravityMethodDraft {
  readonly method: AntigravityAuthMethod;
  readonly project: string;
  readonly location: string;
  /** A key typed now; empty keeps the saved one. */
  readonly key: string;
}

export function antigravityDraftFor(
  setup: AntigravitySignInSetup,
  method: AntigravityAuthMethod,
): AntigravityMethodDraft {
  return { method, project: setup.project, location: setup.location, key: "" };
}

/** Whether `method`'s key is saved on the instance (each method has its own). */
export function antigravityKeySaved(
  instance: ProviderInstanceConfig,
  method: AntigravityAuthMethod,
): boolean {
  const config =
    typeof instance.config === "object" && instance.config !== null ? instance.config : {};
  return readAntigravitySignInSetup({
    config: { ...config, authMethod: method },
    environment: instance.environment,
  }).hasKey;
}

const usesProject = (method: AntigravityAuthMethod) =>
  antigravityAuthMethodInfo(method).project !== "none";

/** Whether saving the draft gives its method everything it needs to be tried. */
export function antigravityDraftReady(
  instance: ProviderInstanceConfig,
  draft: AntigravityMethodDraft,
): boolean {
  return (
    antigravityMissingSetup({
      method: draft.method,
      project: draft.project.trim(),
      location: draft.location.trim(),
      hasKey: draft.key.trim().length > 0 || antigravityKeySaved(instance, draft.method),
    }) === undefined
  );
}

/** Whether the draft differs from what is saved. */
export function antigravityDraftChanged(
  setup: AntigravitySignInSetup,
  draft: AntigravityMethodDraft,
): boolean {
  if (draft.method !== setup.method || draft.key.trim().length > 0) return true;
  return (
    usesProject(draft.method) &&
    (draft.project.trim() !== setup.project || draft.location.trim() !== setup.location)
  );
}

function withEnvironment(
  instance: ProviderInstanceConfig,
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): ProviderInstanceConfig {
  const { environment: _omit, ...rest } = instance;
  return environment.length > 0 ? { ...rest, environment } : rest;
}

const isKeyVariable = (variable: ProviderInstanceEnvironmentVariable, name: string) =>
  variable.name.trim().toUpperCase() === name;

/**
 * The instance with the draft saved: the method, its project (methods
 * without one keep the stored project for a later switch back) and a newly
 * typed key, as a secret under the method's own name.
 */
export function applyAntigravityDraft(
  instance: ProviderInstanceConfig,
  draft: AntigravityMethodDraft,
): ProviderInstanceConfig {
  const config =
    typeof instance.config === "object" && instance.config !== null ? instance.config : {};
  const next: ProviderInstanceConfig = {
    ...instance,
    config: {
      ...config,
      authMethod: draft.method,
      ...(usesProject(draft.method)
        ? { gcpProject: draft.project.trim(), gcpLocation: draft.location.trim() }
        : {}),
    },
  };
  const keyName = antigravityAuthMethodInfo(draft.method).keyEnvName;
  const key = draft.key.trim();
  if (!keyName || !key) return next;
  return withEnvironment(next, [
    ...(instance.environment ?? []).filter((variable) => !isKeyVariable(variable, keyName)),
    { name: keyName, value: key, sensitive: true },
  ]);
}

/** The instance without `method`'s key. */
export function removeAntigravityKey(
  instance: ProviderInstanceConfig,
  method: AntigravityAuthMethod,
): ProviderInstanceConfig {
  const keyName = antigravityAuthMethodInfo(method).keyEnvName;
  if (!keyName) return instance;
  return withEnvironment(
    instance,
    (instance.environment ?? []).filter((variable) => !isKeyVariable(variable, keyName)),
  );
}

export function antigravityApplyLabel(
  setup: AntigravitySignInSetup,
  draft: AntigravityMethodDraft,
): string {
  if (draft.method === setup.method) return "Save";
  if (draft.method === "oauth-business") return "Switch and sign in";
  return `Switch to ${antigravityAuthMethodInfo(draft.method).name}`;
}

/**
 * Whether saving the draft starts the method's sign-in or check right away:
 * a switch to Gemini Enterprise signs in; a key method checks (free, and it
 * is what the user is waiting to hear). A switch back to a Google account
 * keeps its saved sign-in, so nothing starts.
 */
export function antigravityRunsAfterSave(
  setup: AntigravitySignInSetup,
  draft: AntigravityMethodDraft,
): boolean {
  switch (draft.method) {
    case "oauth-personal":
      return false;
    case "oauth-business":
      return draft.method !== setup.method;
    case "gemini-api-key":
    case "agent-platform":
      return true;
  }
}
