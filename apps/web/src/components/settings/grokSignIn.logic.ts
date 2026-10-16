/**
 * Grok's two ways to sign in, as the Account tab, setup and the chat's
 * sign-in buttons present them: a Grok subscription (xAI's own sign-in,
 * the default) or an xAI API key, billed per use.
 *
 * The method is `authMethod` on the instance's settings. The key is the
 * instance's secret environment variable `XAI_API_KEY`; with a subscription
 * the server keeps any key out of Grok's process, so a saved key can stay for
 * a later switch back.
 *
 * @module grokSignIn.logic
 */
import type {
  GrokAuthMethod,
  ProviderInstanceConfig,
  ProviderInstanceEnvironmentVariable,
} from "@threadlines/contracts";

export const GROK_API_KEY_ENV_NAME = "XAI_API_KEY";

/** Where xAI issues API keys, for the Account tab's link. */
export const XAI_API_KEY_PAGE = "https://console.x.ai";

export interface GrokAuthMethodInfo {
  readonly id: GrokAuthMethod;
  readonly name: string;
  readonly description: string;
  /** "plan": a subscription the user pays for already. "perUse": xAI bills each request. */
  readonly billing: "plan" | "perUse";
}

export const GROK_AUTH_METHODS: ReadonlyArray<GrokAuthMethodInfo> = [
  {
    id: "subscription",
    name: "Grok subscription",
    description: "Sign in with your xAI account. Works with SuperGrok and X Premium.",
    billing: "plan",
  },
  {
    id: "api-key",
    name: "xAI API key",
    description: "Billed per use by xAI.",
    billing: "perUse",
  },
];

export function grokAuthMethodInfo(id: GrokAuthMethod): GrokAuthMethodInfo {
  return GROK_AUTH_METHODS.find((method) => method.id === id) ?? GROK_AUTH_METHODS[0]!;
}

/** An instance's sign-in as its settings describe it. */
export interface GrokSignInSetup {
  readonly method: GrokAuthMethod;
  /** An API key is saved (clients only see that a secret exists). */
  readonly hasKey: boolean;
  /** The instance keeps its sign-in in its own folder (an extra account), not `~/.grok`. */
  readonly ownFolder: boolean;
}

const configRecord = (config: unknown): Record<string, unknown> =>
  typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};

const isKeyVariable = (variable: { readonly name: string }) =>
  variable.name.trim().toUpperCase() === GROK_API_KEY_ENV_NAME;

/** Reads the sign-in from an instance's raw config and environment list. */
export function readGrokSignInSetup(
  instance: Pick<ProviderInstanceConfig, "config" | "environment">,
): GrokSignInSetup {
  const config = configRecord(instance.config);
  const key = instance.environment?.find(isKeyVariable);
  const folder = config.accountFolder;
  return {
    method: config.authMethod === "api-key" ? "api-key" : "subscription",
    hasKey: key !== undefined && (key.value.trim().length > 0 || key.valueRedacted === true),
    ownFolder: typeof folder === "string" && folder.trim().length > 0,
  };
}

/**
 * The one next step for a Grok instance that isn't signed in, the same on
 * every surface: run the sign-in or the key check (`run`), or open the
 * Account tab when only its key field can help (`settings`). `hint` says
 * what that field wants, for surfaces with room to say it.
 */
export interface GrokNextStep {
  readonly kind: "run" | "settings";
  readonly label: string;
  readonly hint?: string;
}

export function grokNextStep(setup: GrokSignInSetup): GrokNextStep {
  if (setup.method === "subscription") return { kind: "run", label: "Sign in with Grok" };
  if (!setup.hasKey) {
    return { kind: "settings", label: "Add key", hint: "Add an xAI API key to use Grok." };
  }
  return { kind: "run", label: "Check key" };
}

/** What the Account tab's method choice holds before it is saved. */
export interface GrokMethodDraft {
  readonly method: GrokAuthMethod;
  /** A key typed now; empty keeps the saved one. */
  readonly key: string;
}

/** Whether the draft differs from what is saved. */
export function grokDraftChanged(setup: GrokSignInSetup, draft: GrokMethodDraft): boolean {
  return draft.method !== setup.method || draft.key.trim().length > 0;
}

/** Whether saving the draft gives its method what it needs: a key, for the key method. */
export function grokDraftReady(setup: GrokSignInSetup, draft: GrokMethodDraft): boolean {
  return draft.method === "subscription" || setup.hasKey || draft.key.trim().length > 0;
}

function withEnvironment(
  instance: ProviderInstanceConfig,
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): ProviderInstanceConfig {
  const { environment: _omit, ...rest } = instance;
  return environment.length > 0 ? { ...rest, environment } : rest;
}

/**
 * The instance with the draft saved: the method, and a newly typed key as the
 * secret `XAI_API_KEY`. A saved key stays when switching to a subscription,
 * ready for a switch back; the server keeps it out of Grok meanwhile.
 */
export function applyGrokDraft(
  instance: ProviderInstanceConfig,
  draft: GrokMethodDraft,
): ProviderInstanceConfig {
  const next: ProviderInstanceConfig = {
    ...instance,
    config: { ...configRecord(instance.config), authMethod: draft.method },
  };
  const key = draft.key.trim();
  if (draft.method !== "api-key" || !key) return next;
  return withEnvironment(next, [
    ...(instance.environment ?? []).filter((variable) => !isKeyVariable(variable)),
    { name: GROK_API_KEY_ENV_NAME, value: key, sensitive: true },
  ]);
}

/** The instance without its xAI API key. */
export function removeGrokKey(instance: ProviderInstanceConfig): ProviderInstanceConfig {
  return withEnvironment(
    instance,
    (instance.environment ?? []).filter((variable) => !isKeyVariable(variable)),
  );
}

/**
 * Whether saving the draft starts the method's check right away: a key is
 * checked (free, and it is what the user is waiting to hear). A switch back
 * to the subscription keeps its saved sign-in, so nothing starts.
 */
export function grokRunsAfterSave(draft: GrokMethodDraft): boolean {
  return draft.method === "api-key";
}

export function grokApplyLabel(setup: GrokSignInSetup, draft: GrokMethodDraft): string {
  if (draft.method === setup.method) return "Save key";
  return `Switch to ${grokAuthMethodInfo(draft.method).name}`;
}
