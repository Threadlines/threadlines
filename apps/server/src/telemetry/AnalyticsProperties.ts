import { isProviderAvailable, type ServerProvider } from "@threadlines/contracts";
import { isProviderAuthErrorMessage } from "@threadlines/shared/providerAuth";

export type AnalyticsModelKind = "known" | "custom" | "unknown";
export type AnalyticsModelFamily =
  | "gpt"
  | "claude"
  | "gemini"
  | "cursor"
  | "opencode"
  | "auto"
  | "other"
  | "unknown";

export type AnalyticsFailureCategory =
  | "auth"
  | "context_length"
  | "missing_directory"
  | "model_unavailable"
  | "network"
  | "not_installed"
  | "overloaded"
  | "permission"
  | "process_exit"
  | "provider_error"
  | "rate_limit"
  | "session_lost"
  | "transport"
  | "validation"
  | "unknown";

export type AnalyticsRerouteReasonCategory =
  | "fallback"
  | "model_unavailable"
  | "refusal"
  | "unknown";
export type AnalyticsSessionStartKind =
  | "fresh"
  | "provider_switch"
  | "resume"
  | "same_provider_restart";

interface AnalyticsModel {
  readonly model: string;
  readonly modelKind: AnalyticsModelKind;
  readonly modelFamily: AnalyticsModelFamily;
}

interface ModelPropertyInput {
  readonly model: string | null | undefined;
  readonly provider?: string | undefined;
  readonly prefix?: string | undefined;
}

const MAX_ANALYTICS_MODEL_LENGTH = 96;

const KNOWN_SAFE_MODELS = new Set([
  "auto",
  "default",
  "composer-1.5",
  "composer-2",
  "gpt-5.2",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5-codex",
  "gpt-5.5-codex",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-haiku-4-5",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
]);

const SAFE_PUBLIC_MODEL_PATTERNS = [
  /^gpt-\d+(?:[.-][a-z0-9]+)*(?:-codex(?:-[a-z0-9]+)?)?$/,
  /^claude-(?:fable|haiku|opus|sonnet)-\d+(?:-\d+)*(?:-\d{8})?$/,
  /^composer-\d+(?:\.\d+)?$/,
  /^(?:auto|default)$/,
];

function normalizeModelString(model: string | null | undefined): string | undefined {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized.length > MAX_ANALYTICS_MODEL_LENGTH
    ? normalized.slice(0, MAX_ANALYTICS_MODEL_LENGTH)
    : normalized;
}

function inferModelFamily(model: string | undefined): AnalyticsModelFamily {
  if (!model) return "unknown";
  if (model.includes("claude")) return "claude";
  if (model.includes("gpt") || /^o\d/.test(model)) return "gpt";
  if (model.includes("gemini")) return "gemini";
  if (model.includes("composer") || model.includes("cursor")) return "cursor";
  if (model.includes("opencode")) return "opencode";
  if (model === "auto" || model === "default") return "auto";
  return "other";
}

function isSafeKnownModel(model: string): boolean {
  if (model.includes("/") || model.includes("\\") || model.includes("@") || model.includes(":")) {
    return false;
  }
  if (KNOWN_SAFE_MODELS.has(model)) {
    return true;
  }
  return SAFE_PUBLIC_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}

export function normalizeAnalyticsModel(
  model: string | null | undefined,
  _provider?: string,
): AnalyticsModel {
  const normalized = normalizeModelString(model);
  if (!normalized) {
    return {
      model: "unknown",
      modelKind: "unknown",
      modelFamily: "unknown",
    };
  }

  const modelFamily = inferModelFamily(normalized);
  if (isSafeKnownModel(normalized)) {
    return {
      model: normalized,
      modelKind: "known",
      modelFamily,
    };
  }

  return {
    model: "custom",
    modelKind: "custom",
    modelFamily,
  };
}

export function analyticsModelProperties({
  model,
  provider,
  prefix,
}: ModelPropertyInput): Record<string, string> {
  const normalized = normalizeAnalyticsModel(model, provider);
  const keyPrefix = prefix ?? "";
  const modelKey = keyPrefix ? `${keyPrefix}Model` : "model";
  const kindKey = keyPrefix ? `${keyPrefix}ModelKind` : "modelKind";
  const familyKey = keyPrefix ? `${keyPrefix}ModelFamily` : "modelFamily";
  return {
    [modelKey]: normalized.model,
    [kindKey]: normalized.modelKind,
    [familyKey]: normalized.modelFamily,
  };
}

/**
 * Ordered so a provider's own wording wins over generic transport words: the
 * first category with a matching pattern is the one reported. Patterns run
 * against the lowercased message, and only the category leaves the machine.
 */
const FAILURE_CATEGORY_PATTERNS: ReadonlyArray<
  readonly [AnalyticsFailureCategory, ReadonlyArray<string | RegExp>]
> = [
  [
    "rate_limit",
    [
      "rate limit",
      "ratelimit",
      /\b429\b/,
      "quota",
      "usage limit",
      "hit your limit",
      "purchase more credits",
    ],
  ],
  [
    "auth",
    [
      "authentication",
      "unauthorized",
      "not authenticated",
      "invalid api key",
      "login",
      "sign in again",
      "log in again",
      /\b401\b/,
    ],
  ],
  [
    "context_length",
    ["context length", "context window", "maximum context", "too many tokens", "token limit"],
  ],
  ["overloaded", ["at capacity", "overloaded", /\b529\b/, /\b503\b/, "service unavailable"]],
  [
    "model_unavailable",
    [
      "model unavailable",
      "model not available",
      "model_not_found",
      "unknown model",
      "no such model",
      /\bmodel\b.*\bdoes not exist\b/,
    ],
  ],
  [
    "not_installed",
    [
      "binary not found",
      "command not found",
      "not installed",
      "is not recognized as an internal or external command",
      /\bspawn\b.*\benoent\b/,
    ],
  ],
  [
    "session_lost",
    [
      "no conversation found",
      "session not found",
      "thread not found",
      "thread does not exist",
      "no such thread",
      "unknown thread",
      "missing thread",
      "no rollout found",
    ],
  ],
  [
    "network",
    [
      "network",
      "timeout",
      "timed out",
      "econn",
      "enotfound",
      "fetch failed",
      "websocket",
      "connection refused",
      "connection reset",
    ],
  ],
  [
    "process_exit",
    ["process exited", "exited with code", "exited unexpectedly", "sigterm", "sigkill"],
  ],
  ["missing_directory", ["does not exist", "no longer exists", "no such file or directory"]],
  ["permission", ["permission", "not allowed", "access denied", "sandbox"]],
  ["validation", ["invalid request", "validation"]],
];

/**
 * Paths in an error name the user's folders, and folder names are arbitrary
 * words ("auth-fix", "network-tools", "model"). Matching runs on the message
 * with quoted paths and bare path tokens blanked out, so only the provider's
 * own wording picks the category.
 */
const QUOTED_PATH_PATTERN = /"[^"]*[\\/][^"]*"|`[^`]*[\\/][^`]*`/g;
const BARE_PATH_PATTERN = /(?<=^|[\s(:='])(?:[a-z]:)?~?\.{0,2}[\\/][^\s"'`)]*/g;

function failureHaystack(input: {
  readonly message?: string | null | undefined;
  readonly reason?: string | null | undefined;
}): string {
  return `${input.message ?? ""} ${input.reason ?? ""}`
    .toLowerCase()
    .replace(QUOTED_PATH_PATTERN, " ")
    .replace(BARE_PATH_PATTERN, " ");
}

export function classifyProviderFailure(input: {
  readonly errorClass?: string | undefined;
  readonly message?: string | null | undefined;
  readonly reason?: string | null | undefined;
}): AnalyticsFailureCategory {
  switch (input.errorClass) {
    case "authentication_error":
      return "auth";
    case "permission_error":
      return "permission";
    case "validation_error":
      return "validation";
    case "transport_error":
      return "transport";
    case "provider_error":
      break;
    case "unknown":
    case undefined:
      break;
    default:
      break;
  }

  const haystack = failureHaystack(input);
  if (!haystack.trim()) {
    return input.errorClass === "provider_error" ? "provider_error" : "unknown";
  }
  if (isProviderAuthErrorMessage(input.message)) {
    return "auth";
  }

  const match = FAILURE_CATEGORY_PATTERNS.find(([, patterns]) =>
    patterns.some((pattern) =>
      typeof pattern === "string" ? haystack.includes(pattern) : pattern.test(haystack),
    ),
  );
  if (match) {
    return match[0];
  }

  return input.errorClass === "provider_error" ? "provider_error" : "unknown";
}

export function classifyModelRerouteReason(reason: string | null | undefined): {
  readonly reasonCategory: AnalyticsRerouteReasonCategory;
  readonly isFallback: boolean;
} {
  const normalized = reason?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return { reasonCategory: "unknown", isFallback: false };
  }
  const isFallback = normalized.includes("fallback");
  if (normalized.includes("refusal")) {
    return { reasonCategory: "refusal", isFallback };
  }
  if (normalized.includes("unavailable") || normalized.includes("not_available")) {
    return { reasonCategory: "model_unavailable", isFallback };
  }
  if (isFallback) {
    return { reasonCategory: "fallback", isFallback };
  }
  return { reasonCategory: "unknown", isFallback };
}

export function classifyProviderSessionStart(input: {
  readonly hasPreviousBinding: boolean;
  readonly previousProvider?: string | undefined;
  readonly previousInstanceId?: string | undefined;
  readonly nextProvider: string;
  readonly nextInstanceId: string;
  readonly hasContextSeed: boolean;
  readonly hasResumeCursor: boolean;
}): AnalyticsSessionStartKind {
  if (!input.hasPreviousBinding) {
    return "fresh";
  }
  if (
    input.hasContextSeed ||
    input.previousProvider !== input.nextProvider ||
    input.previousInstanceId !== input.nextInstanceId
  ) {
    return "provider_switch";
  }
  if (input.hasResumeCursor) {
    return "resume";
  }
  return "same_provider_restart";
}

export type AnalyticsSignInState = "yes" | "no" | "unknown";

/** Property prefixes for the drivers we report by name; others only count toward the totals. */
const READINESS_DRIVER_KEYS: Readonly<Record<string, string>> = {
  claudeAgent: "claude",
  codex: "codex",
  cursor: "cursor",
  fx: "fx",
};

/** Same order of evidence the Settings status line uses. */
function signInState(snapshot: ServerProvider): AnalyticsSignInState {
  const chat = snapshot.auth.capabilities?.chat?.status;
  if (chat === "verified" || chat === "configured") return "yes";
  if (chat === "unavailable") return "no";
  if (snapshot.auth.status === "authenticated") return "yes";
  if (snapshot.auth.status === "unauthenticated") return "no";
  return "unknown";
}

function mergeSignIn(states: ReadonlyArray<AnalyticsSignInState>): AnalyticsSignInState {
  if (states.includes("yes")) return "yes";
  if (states.includes("no")) return "no";
  return "unknown";
}

/**
 * Whether the provider checks have finished, so a readiness report describes
 * the machine rather than the first moments after launch. A probe that timed
 * out counts as finished: its retry reports again if the answer changes.
 */
export function providerChecksSettled(providers: ReadonlyArray<ServerProvider>): boolean {
  return (
    providers.length > 0 &&
    providers.every((provider) => provider.statusReason !== "provider_probe_pending")
  );
}

/**
 * Answers about whether this machine can chat with an agent: per known
 * driver whether it is turned on, installed, and signed in (yes, no, or
 * unknown), plus totals across every driver. Account names, emails, and
 * versions never leave.
 */
export function providerReadinessProperties(
  providers: ReadonlyArray<ServerProvider>,
): Record<string, string | boolean> {
  const live = providers.filter((provider) => provider.enabled && isProviderAvailable(provider));
  // A probe that is still running or timed out never verified anything, so
  // it can't vouch for readiness even when its placeholder looks hopeful.
  const isReady = (provider: ServerProvider) =>
    provider.installed &&
    provider.statusReason === undefined &&
    signInState(provider) !== "no" &&
    provider.status !== "error" &&
    provider.status !== "disabled";

  const properties: Record<string, string | boolean> = {
    anyAgentInstalled: live.some((provider) => provider.installed),
    anyAgentSignedIn: live.some(
      (provider) => provider.installed && signInState(provider) === "yes",
    ),
    anyAgentReady: live.some(isReady),
    anyAgentCheckTimedOut: live.some(
      (provider) => provider.statusReason === "provider_probe_timeout",
    ),
  };
  for (const [driver, key] of Object.entries(READINESS_DRIVER_KEYS)) {
    const instances = providers.filter((provider) => provider.driver === driver);
    if (instances.length === 0) continue;
    const enabled = instances.filter((provider) => live.includes(provider));
    properties[`${key}Enabled`] = enabled.length > 0;
    properties[`${key}Installed`] = enabled.some((provider) => provider.installed);
    properties[`${key}SignedIn`] = mergeSignIn(
      enabled.filter((provider) => provider.installed).map(signInState),
    );
  }
  return properties;
}
