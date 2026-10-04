/**
 * Antigravity's sign-in methods as Threadlines presents them, shared by the
 * server (status, flows) and clients (the Account tab, setup, notices).
 *
 * The ids are Antigravity's own ACP auth method ids. The two browser methods
 * keep a saved Google token in the instance's profile; the two key methods
 * take a key from the instance's secret environment, under one name per
 * method so switching never feeds one method's key to the other.
 *
 * @module antigravitySignIn
 */
import type { AntigravityAuthMethod } from "@threadlines/contracts";

export interface AntigravityAuthMethodInfo {
  readonly id: AntigravityAuthMethod;
  readonly name: string;
  readonly description: string;
  /** "plan": a subscription the user pays for already. "perUse": Google bills each request. */
  readonly billing: "plan" | "perUse";
  /** Opens a Google sign-in page. */
  readonly browser: boolean;
  /** The secret environment variable that holds this method's key, if it takes one. */
  readonly keyEnvName: string | null;
  /** Needs a Google Cloud project and location ("required"), or only without a key ("withoutKey"). */
  readonly project: "required" | "withoutKey" | "none";
}

export const ANTIGRAVITY_AUTH_METHODS: ReadonlyArray<AntigravityAuthMethodInfo> = [
  {
    id: "oauth-personal",
    name: "Google account",
    description: "Uses your Google AI plan.",
    billing: "plan",
    browser: true,
    keyEnvName: null,
    project: "none",
  },
  {
    id: "oauth-business",
    name: "Gemini Enterprise",
    description: "Your company's Gemini plan, through Google Cloud.",
    billing: "plan",
    browser: true,
    keyEnvName: null,
    project: "required",
  },
  {
    id: "gemini-api-key",
    name: "Gemini API key",
    description: "Pay for what you use. Get a key in Google AI Studio.",
    billing: "perUse",
    browser: false,
    keyEnvName: "GEMINI_API_KEY",
    project: "none",
  },
  {
    id: "agent-platform",
    name: "Vertex AI",
    description: "Pay for what you use, billed to a Google Cloud project.",
    billing: "perUse",
    browser: false,
    keyEnvName: "GOOGLE_API_KEY",
    project: "withoutKey",
  },
];

export const ANTIGRAVITY_DEFAULT_AUTH_METHOD: AntigravityAuthMethod = "oauth-personal";

export function antigravityAuthMethodInfo(
  id: AntigravityAuthMethod | string | undefined,
): AntigravityAuthMethodInfo {
  return (
    ANTIGRAVITY_AUTH_METHODS.find((method) => method.id === id) ?? ANTIGRAVITY_AUTH_METHODS[0]!
  );
}

/** Names that hold Antigravity keys: always stored and returned as secrets. */
export const ANTIGRAVITY_KEY_ENV_NAMES: ReadonlyArray<string> = ANTIGRAVITY_AUTH_METHODS.flatMap(
  (method) => (method.keyEnvName ? [method.keyEnvName] : []),
);

export function isAntigravityKeyEnvName(name: string): boolean {
  const upper = name.trim().toUpperCase();
  return ANTIGRAVITY_KEY_ENV_NAMES.includes(upper);
}

/** Where Google issues keys for a method, for the Account tab's link. */
export const GEMINI_API_KEY_PAGE = "https://aistudio.google.com/apikey";

/** An instance's sign-in as its settings describe it. */
export interface AntigravitySignInSetup {
  readonly method: AntigravityAuthMethod;
  readonly project: string;
  readonly location: string;
  /** The method's key is saved (clients only see that a secret exists). */
  readonly hasKey: boolean;
}

const readString = (record: unknown, key: string): string => {
  if (typeof record !== "object" || record === null) return "";
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
};

/** Reads the sign-in from an instance's raw config and environment list. */
export function readAntigravitySignInSetup(instance: {
  readonly config?: unknown;
  readonly environment?:
    | ReadonlyArray<{
        readonly name: string;
        readonly value: string;
        readonly valueRedacted?: boolean | undefined;
      }>
    | undefined;
}): AntigravitySignInSetup {
  const info = antigravityAuthMethodInfo(readString(instance.config, "authMethod"));
  const key = info.keyEnvName
    ? instance.environment?.find(
        (variable) => variable.name.trim().toUpperCase() === info.keyEnvName,
      )
    : undefined;
  return {
    method: info.id,
    project: readString(instance.config, "gcpProject"),
    location: readString(instance.config, "gcpLocation"),
    hasKey: key !== undefined && (key.value.trim().length > 0 || key.valueRedacted === true),
  };
}

/** What the method still needs before it can even be tried, or `undefined`. */
export function antigravityMissingSetup(
  setup: AntigravitySignInSetup,
): "project" | "key" | undefined {
  const hasProject = setup.project.length > 0 && setup.location.length > 0;
  switch (setup.method) {
    case "oauth-personal":
      return undefined;
    case "oauth-business":
      return hasProject ? undefined : "project";
    case "gemini-api-key":
      return setup.hasKey ? undefined : "key";
    case "agent-platform":
      // A key replaces the project; without one, the project names who pays.
      return setup.hasKey || hasProject ? undefined : "project";
  }
}

/**
 * The one next step for an Antigravity instance that isn't ready, the same
 * on every surface: run its sign-in or check (`run`), or open its Account
 * tab in Settings for something only a field there can fix (`settings`).
 */
export interface AntigravityNextStep {
  readonly kind: "run" | "settings";
  readonly label: string;
}

export function antigravityNextStep(input: {
  readonly setup: AntigravitySignInSetup;
  /** The instance's last status, when there is one. */
  readonly snapshot?: {
    readonly status: string;
    readonly auth: { readonly status: string; readonly type?: string | undefined };
  };
}): AntigravityNextStep {
  const { setup, snapshot } = input;
  const missing = antigravityMissingSetup(setup);
  if (missing === "key") return { kind: "settings", label: "Add key" };
  if (missing === "project") return { kind: "settings", label: "Set up" };
  const rejectedKey =
    setup.method === "gemini-api-key" &&
    snapshot?.auth.type === setup.method &&
    snapshot.status === "error" &&
    snapshot.auth.status === "unauthenticated";
  if (rejectedKey) return { kind: "settings", label: "Replace key" };
  switch (setup.method) {
    case "oauth-personal":
      return { kind: "run", label: "Sign in with Google" };
    case "oauth-business":
      return { kind: "run", label: "Sign in" };
    case "gemini-api-key":
      return { kind: "run", label: "Check key" };
    case "agent-platform":
      return { kind: "run", label: "Check again" };
  }
}
