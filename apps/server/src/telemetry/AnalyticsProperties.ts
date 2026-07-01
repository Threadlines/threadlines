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
  | "model_unavailable"
  | "network"
  | "permission"
  | "provider_error"
  | "rate_limit"
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
  "claude-haiku-4-5",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
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

  const haystack = `${input.message ?? ""} ${input.reason ?? ""}`.toLowerCase();
  if (!haystack.trim()) {
    return input.errorClass === "provider_error" ? "provider_error" : "unknown";
  }

  if (
    haystack.includes("rate limit") ||
    haystack.includes("ratelimit") ||
    haystack.includes("429") ||
    haystack.includes("quota")
  ) {
    return "rate_limit";
  }
  if (
    haystack.includes("authentication") ||
    haystack.includes("unauthorized") ||
    haystack.includes("not authenticated") ||
    haystack.includes("invalid api key") ||
    haystack.includes("login") ||
    haystack.includes("401")
  ) {
    return "auth";
  }
  if (
    haystack.includes("context length") ||
    haystack.includes("context window") ||
    haystack.includes("maximum context") ||
    haystack.includes("too many tokens") ||
    haystack.includes("token limit")
  ) {
    return "context_length";
  }
  if (
    haystack.includes("model unavailable") ||
    haystack.includes("model not available") ||
    haystack.includes("model_not_found") ||
    haystack.includes("unknown model") ||
    haystack.includes("no such model")
  ) {
    return "model_unavailable";
  }
  if (
    haystack.includes("network") ||
    haystack.includes("timeout") ||
    haystack.includes("timed out") ||
    haystack.includes("econn") ||
    haystack.includes("enotfound") ||
    haystack.includes("fetch failed") ||
    haystack.includes("websocket") ||
    haystack.includes("connection refused") ||
    haystack.includes("connection reset")
  ) {
    return "network";
  }
  if (
    haystack.includes("permission") ||
    haystack.includes("not allowed") ||
    haystack.includes("access denied") ||
    haystack.includes("sandbox")
  ) {
    return "permission";
  }
  if (haystack.includes("invalid request") || haystack.includes("validation")) {
    return "validation";
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
