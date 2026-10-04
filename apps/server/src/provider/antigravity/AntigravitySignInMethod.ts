/**
 * AntigravitySignInMethod — how one Antigravity instance signs in, per the
 * method its settings pick (`@threadlines/shared/antigravitySignIn`): what
 * its agent processes get, what its profile records, and what its status
 * says.
 *
 * - Keys come from the instance's own environment list, never the merged
 *   environment: an ambient `GEMINI_API_KEY` can't stand in for a missing
 *   one. Each method has its own name, so a key never reaches the other
 *   method.
 * - Keyless Vertex AI signs in with Application Default Credentials (ADC) on
 *   the computer running Threadlines; only then do the ADC inputs pass
 *   through.
 * - The agent reads the method and Google Cloud project from
 *   `antigravity-acp/settings.json` in the profile. Threadlines merges its
 *   part in when the instance is built and before a sign-in, never on every
 *   launch, and leaves the agent's own keys alone.
 * - What a check found (a key Google rejected) is kept per credential, so a
 *   new key starts fresh and an old verdict never sticks to it.
 *
 * Verified against Antigravity 1.3.0: the agent picks the method from the
 * settings file at start, `authenticate` with a key method never tests the
 * key, and a keyless Vertex AI session opens without ADC (the first prompt
 * fails). So a key or ADC is only proven by a request; status says
 * "configured" until a check passes.
 *
 * @module provider/antigravity/AntigravitySignInMethod
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  AntigravityAuthMethod,
  AntigravitySettings,
  ProviderInstanceEnvironment,
  ServerProviderAuth,
} from "@threadlines/contracts";
import {
  antigravityAuthMethodInfo,
  antigravityMissingSetup as missingSetup,
} from "@threadlines/shared/antigravitySignIn";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { antigravityAgentDir, antigravityTokenPath } from "./AntigravityProfile.ts";

export interface AntigravitySignInConfig {
  readonly method: AntigravityAuthMethod;
  /** Set only for methods that use a Google Cloud project. */
  readonly project: string;
  readonly location: string;
  /** The method's key from the instance's environment list; empty when it has none. */
  readonly key: string;
}

/** The sign-in an instance's settings and environment list describe. */
export function antigravitySignInConfig(
  settings: Pick<AntigravitySettings, "authMethod" | "gcpProject" | "gcpLocation">,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
): AntigravitySignInConfig {
  const info = antigravityAuthMethodInfo(settings.authMethod);
  const keyName = info.keyEnvName;
  const key = keyName
    ? (instanceEnvironment
        ?.find((variable) => variable.name.trim().toUpperCase() === keyName)
        ?.value.trim() ?? "")
    : "";
  const usesProject = info.project !== "none";
  return {
    method: info.id,
    project: usesProject ? settings.gcpProject.trim() : "",
    location: usesProject ? settings.gcpLocation.trim() : "",
    key,
  };
}

/** What the method still needs before it can be tried (not whether it works). */
export const antigravityMissingSetup = (config: AntigravitySignInConfig) =>
  missingSetup({ ...config, hasKey: config.key.length > 0 });

// ── Process environment ──────────────────────────────────────────────

/** Inputs to Application Default Credentials, passed to keyless Vertex AI only. */
const ADC_ENV_NAMES = ["GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG"] as const;

/** A variable by name, ignoring case: Windows names are case-insensitive. */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper) return value;
  }
  return undefined;
}

/**
 * What the agent needs on top of the stripped environment: the method's own
 * key, or for keyless Vertex AI the ADC inputs of the computer running
 * Threadlines (`base`: the server's environment with the instance's own
 * variables over it).
 */
export function antigravityCredentialEnvironment(
  config: AntigravitySignInConfig,
  base: NodeJS.ProcessEnv,
): Record<string, string> {
  if (config.method === "gemini-api-key") {
    return config.key ? { GEMINI_API_KEY: config.key } : {};
  }
  if (config.method !== "agent-platform") return {};
  if (config.key) return { GOOGLE_API_KEY: config.key };
  const env: Record<string, string> = {};
  for (const name of ADC_ENV_NAMES) {
    const value = readEnv(base, name)?.trim();
    if (value) env[name] = value;
  }
  return env;
}

// ── Application Default Credentials ──────────────────────────────────

export type AntigravityAdcState =
  | { readonly status: "found"; readonly path: string }
  | { readonly status: "missing"; readonly path: string | undefined }
  | { readonly status: "unreadable"; readonly path: string };

/**
 * Where Google's auth library looks for ADC, in its order: an explicit
 * `GOOGLE_APPLICATION_CREDENTIALS` (and nothing after it), then the gcloud
 * config dir (`CLOUDSDK_CONFIG`, else `%APPDATA%\gcloud` on Windows or
 * `~/.config/gcloud`).
 */
export function antigravityAdcPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { readonly path: string | undefined; readonly explicit: boolean } {
  const explicit = readEnv(env, "GOOGLE_APPLICATION_CREDENTIALS")?.trim();
  if (explicit) return { path: explicit, explicit: true };
  const file = "application_default_credentials.json";
  const configDir = readEnv(env, "CLOUDSDK_CONFIG")?.trim();
  if (configDir) return { path: join(configDir, file), explicit: false };
  if (platform === "win32") {
    const appData = readEnv(env, "APPDATA")?.trim();
    return { path: appData ? join(appData, "gcloud", file) : undefined, explicit: false };
  }
  const home = readEnv(env, "HOME")?.trim() || homedir();
  return { path: join(home, ".config", "gcloud", file), explicit: false };
}

/** Whether ADC is there and looks like a credential (it is only proven by a request). */
export const resolveAntigravityAdc = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
  Effect.promise(async (): Promise<AntigravityAdcState> => {
    const { path, explicit } = antigravityAdcPath(env, platform);
    if (!path) return { status: "missing", path };
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf8");
    } catch (error) {
      // A named file that's gone is a broken setting, not a missing sign-in.
      return (error as NodeJS.ErrnoException).code === "ENOENT" && !explicit
        ? { status: "missing", path }
        : { status: "unreadable", path };
    }
    try {
      const parsed = JSON.parse(raw) as { type?: unknown } | null;
      return typeof parsed?.type === "string"
        ? { status: "found", path }
        : { status: "unreadable", path };
    } catch {
      return { status: "unreadable", path };
    }
  });

// ── Profile settings file ────────────────────────────────────────────

export const antigravitySettingsPath = (profileDir: string) =>
  join(antigravityAgentDir(profileDir), "settings.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The profile settings with the method and project merged in: `auth.type`
 * set, `gcp.project` / `gcp.location` set or removed, everything else the
 * agent wrote kept. Never holds a credential.
 */
export function mergeAntigravityProfileSettings(
  existing: unknown,
  config: AntigravitySignInConfig,
): Record<string, unknown> {
  const next: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
  next.auth = { ...(isRecord(next.auth) ? next.auth : {}), type: config.method };
  const gcp: Record<string, unknown> = isRecord(next.gcp) ? { ...next.gcp } : {};
  for (const [field, value] of [
    ["project", config.project],
    ["location", config.location],
  ] as const) {
    if (value) gcp[field] = value;
    else delete gcp[field];
  }
  if (Object.keys(gcp).length > 0) next.gcp = gcp;
  else delete next.gcp;
  return next;
}

async function writePrivateFileAtomically(target: string, contents: string): Promise<void> {
  const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, contents, { mode: 0o600 });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Records the method and project in the profile, for the agent's next
 * process. Unchanged settings are not rewritten.
 */
export const writeAntigravityProfileSettings = (
  profileDir: string,
  config: AntigravitySignInConfig,
) =>
  Effect.tryPromise({
    try: async () => {
      const target = antigravitySettingsPath(profileDir);
      await fs.mkdir(antigravityAgentDir(profileDir), { recursive: true, mode: 0o700 });
      const raw = await fs.readFile(target, "utf8").catch(() => undefined);
      let existing: unknown;
      try {
        existing = raw === undefined ? undefined : JSON.parse(raw);
      } catch {
        // Unreadable: replaced by Threadlines' part alone.
      }
      const merged = mergeAntigravityProfileSettings(existing, config);
      if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(merged)) return;
      await writePrivateFileAtomically(target, `${JSON.stringify(merged, null, 2)}\n`);
    },
    catch: (cause) =>
      new Error(`Couldn't save Antigravity's sign-in settings: ${String(cause)}`, { cause }),
  });

// ── Credential fingerprint and check results ─────────────────────────

/**
 * Names one sign-in configuration without holding the key: caches and check
 * results recorded for another method, project or key don't apply.
 */
export function antigravityCredentialFingerprint(config: AntigravitySignInConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "antigravity-sign-in/1",
        config.method,
        config.project,
        config.location,
        config.key,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

export interface AntigravitySignInCheck {
  readonly fingerprint: string;
  readonly accepted: boolean;
  /** Google's reason for a rejection, worded for the user. */
  readonly message?: string;
  readonly checkedAt: string;
}

const checkPath = (profileDir: string) => join(profileDir, "threadlines-sign-in-check.json");

/** The last check of this exact configuration, if any. */
export const readAntigravitySignInCheck = (profileDir: string, fingerprint: string) =>
  Effect.promise(async (): Promise<AntigravitySignInCheck | undefined> => {
    const raw = await fs.readFile(checkPath(profileDir), "utf8").catch(() => undefined);
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<AntigravitySignInCheck>;
      if (parsed.fingerprint !== fingerprint || typeof parsed.accepted !== "boolean") {
        return undefined;
      }
      return {
        fingerprint,
        accepted: parsed.accepted,
        ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
        checkedAt: typeof parsed.checkedAt === "string" ? parsed.checkedAt : "",
      };
    } catch {
      return undefined;
    }
  });

/** Best effort: a check that can't be recorded still reports its result. */
export const writeAntigravitySignInCheck = (profileDir: string, check: AntigravitySignInCheck) =>
  Effect.tryPromise(async () => {
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    await writePrivateFileAtomically(checkPath(profileDir), JSON.stringify(check));
  }).pipe(Effect.ignore);

// ── Which Google sign-in the profile holds ──────────────────────────

/** The OAuth clients Antigravity 1.3.0 signs in with, per method. */
const GOOGLE_ACCOUNT_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const GEMINI_ENTERPRISE_CLIENT_ID =
  "884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com";
/** Gemini Code Assist's scope: only a Google account sign-in asks for it. */
const CODE_ASSIST_SCOPE = "https://www.googleapis.com/auth/aicode";

/**
 * Which Google method a saved token belongs to. Google account and Gemini
 * Enterprise share one token file; the token names the OAuth client that
 * issued it, and only a Google account's carries the Code Assist scope.
 */
export function classifyAntigravityGoogleToken(
  token: unknown,
): "oauth-personal" | "oauth-business" | undefined {
  if (!isRecord(token) || Object.keys(token).length === 0) return undefined;
  if (token.client_id === GOOGLE_ACCOUNT_CLIENT_ID) return "oauth-personal";
  if (token.client_id === GEMINI_ENTERPRISE_CLIENT_ID) return "oauth-business";
  const scopes = Array.isArray(token.scopes) ? token.scopes : undefined;
  return scopes && !scopes.includes(CODE_ASSIST_SCOPE) ? "oauth-business" : "oauth-personal";
}

/** The Google method the profile's saved sign-in belongs to, or `undefined` when it holds none. */
export const readAntigravityGoogleSignIn = (profileDir: string) =>
  Effect.promise(async () => {
    const raw = await fs.readFile(antigravityTokenPath(profileDir), "utf8").catch(() => "");
    try {
      return classifyAntigravityGoogleToken(JSON.parse(raw));
    } catch {
      return undefined;
    }
  });

// ── Gemini API key check ─────────────────────────────────────────────

export const GEMINI_MODELS_URL =
  "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";
const KEY_CHECK_TIMEOUT_MS = 15_000;

export type GeminiKeyCheck =
  | { readonly verdict: "accepted" }
  | { readonly verdict: "rejected"; readonly message: string }
  | { readonly verdict: "unreachable"; readonly message: string };

function googleErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  const message = body.error.message;
  return typeof message === "string" && message.trim() ? message.trim().slice(0, 300) : undefined;
}

/**
 * Asks Google whether it accepts a Gemini API key: one model-list request,
 * which is free. It proves the key, not access to a given model or quota.
 */
export const checkGeminiApiKey = (key: string, url: string = GEMINI_MODELS_URL) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeaders({ "x-goog-api-key": key, accept: "application/json" }),
        ),
      )
      .pipe(
        Effect.timeoutOption(KEY_CHECK_TIMEOUT_MS),
        Effect.catch(() => Effect.succeed(Option.none())),
      );
    if (Option.isNone(response)) {
      return {
        verdict: "unreachable",
        message: "Couldn't reach Google to check the key. Check the connection and try again.",
      } satisfies GeminiKeyCheck;
    }
    const status = response.value.status;
    // Over quota still means Google knows the key.
    if ((status >= 200 && status < 300) || status === 429) {
      return { verdict: "accepted" } satisfies GeminiKeyCheck;
    }
    const body = yield* response.value.json.pipe(Effect.orElseSucceed(() => undefined));
    if (status === 400 || status === 401 || status === 403) {
      return {
        verdict: "rejected",
        message: googleErrorMessage(body) ?? "Google didn't accept this key.",
      } satisfies GeminiKeyCheck;
    }
    return {
      verdict: "unreachable",
      message: `Google couldn't check the key right now (HTTP ${status}). Try again in a moment.`,
    } satisfies GeminiKeyCheck;
  });

// ── Status ───────────────────────────────────────────────────────────

/** The last four characters of a key, the most of it Threadlines ever shows. */
export function maskAntigravityKey(key: string): string {
  return key.length >= 12 ? `••••${key.slice(-4)}` : "••••";
}

export interface AntigravitySignInStatus {
  readonly status: "ready" | "warning" | "error";
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

const ADC_COMMAND = "gcloud auth application-default login";

/**
 * What an instance's sign-in looks like without starting the agent. `type`
 * is always the method, so a client that just switched can tell when the
 * status reflects the new one.
 */
export function antigravitySignInStatus(input: {
  readonly config: AntigravitySignInConfig;
  /** Whether the profile holds a Google sign-in made with this method (Google methods). */
  readonly signedIn: boolean;
  readonly check: AntigravitySignInCheck | undefined;
  /** ADC as found for keyless Vertex AI. */
  readonly adc: AntigravityAdcState | undefined;
}): AntigravitySignInStatus {
  const { config, signedIn, check, adc } = input;
  const type = config.method;
  const signedOut = (message: string, status: "warning" | "error" = "warning") =>
    ({ status, auth: { status: "unauthenticated", type }, message }) as const;
  const signedInAs = (label: string, chat?: "verified" | "configured", detail?: string) =>
    ({
      status: "ready",
      auth: {
        status: "authenticated",
        type,
        label,
        ...(chat
          ? { capabilities: { chat: { status: chat, ...(detail ? { detail } : {}) } } }
          : {}),
      },
    }) as const;

  switch (config.method) {
    case "oauth-personal":
      return signedIn
        ? signedInAs("Google account")
        : signedOut("Sign in with Google to use Antigravity.");
    case "oauth-business":
      if (antigravityMissingSetup(config)) {
        return signedOut("Add your Google Cloud project and location to use Gemini Enterprise.");
      }
      return signedIn
        ? signedInAs(`Gemini Enterprise · ${config.project}`)
        : signedOut("Sign in with your work Google account to use Gemini Enterprise.");
    case "gemini-api-key": {
      if (!config.key) return signedOut("Add a Gemini API key to use Antigravity.");
      if (check && !check.accepted) {
        return signedOut(
          `Google didn't accept this Gemini API key${check.message ? `: ${check.message}` : "."} Replace the key to use Antigravity.`,
          "error",
        );
      }
      const label = `Gemini API key ${maskAntigravityKey(config.key)} · per use`;
      return check?.accepted
        ? signedInAs(label, "verified", "Google accepted this key.")
        : signedInAs(label, "configured", "Not checked yet. The first request tests the key.");
    }
    case "agent-platform": {
      if (config.key) {
        return signedInAs(
          `Vertex AI ${maskAntigravityKey(config.key)} · per use`,
          "configured",
          "The first request tests the key.",
        );
      }
      if (antigravityMissingSetup(config)) {
        return signedOut(
          "Add your Google Cloud project and location, or a Vertex AI key, to use Vertex AI.",
        );
      }
      if (adc?.status === "unreadable") {
        return signedOut(
          `The Google Cloud credentials at ${adc.path} can't be read. Fix the file or run \`${ADC_COMMAND}\` on the computer that runs Threadlines.`,
          "error",
        );
      }
      if (adc?.status !== "found") {
        return signedOut(
          `Sign in to Google Cloud on the computer that runs Threadlines: \`${ADC_COMMAND}\`.`,
        );
      }
      return signedInAs(
        `Vertex AI · ${config.project} · ${config.location} · per use`,
        "configured",
        "Uses the Google Cloud sign-in on the computer that runs Threadlines. The first request tests it.",
      );
    }
  }
}
