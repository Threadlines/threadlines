import {
  AcpRegistryAgentId,
  isProviderAvailable,
  type ProviderFailureCategory,
  type ServerProvider,
  type ThemeManifest,
} from "@threadlines/contracts";
import { isProviderAuthErrorMessage } from "@threadlines/shared/providerAuth";
import * as Schema from "effect/Schema";

import { PI_PUBLIC_MODELS } from "../provider/pi/_generated/piModelCatalog.gen.ts";

export type AnalyticsModelKind = "known" | "custom" | "unknown";
export type AnalyticsModelFamily =
  | "gpt"
  | "claude"
  | "gemini"
  | "cursor"
  | "opencode"
  | "muse"
  | "grok"
  | "auto"
  | "other"
  | "unknown";

/**
 * Why a turn or runtime failed: a driver's structured category when the agent
 * gave one, otherwise what the message wording says.
 */
export type AnalyticsFailureCategory =
  | ProviderFailureCategory
  | "missing_directory"
  | "not_installed"
  | "process_exit"
  | "provider_error"
  | "session_lost"
  | "transport"
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
  "gemini-pro-agent",
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
  "claude-fable-5-2",
  "claude-haiku-4-5",
  "claude-haiku-5-5",
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
  // `gpt-4o` and its kin end their version in an "o"; no other letter.
  /^gpt-\d{1,2}o?(?:[.-]\d{1,2})?(?:-(?:mini|nano|pro|turbo|preview|latest|chat|codex|spark|astra|sol|luna|terra|max|high|low|medium|xhigh|extra|minimal|none|fast|thinking|batch))+(?:-20[2-3]\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))?$/,
  /^gpt-\d{1,2}o?(?:[.-]\d{1,2})?(?:-20[2-3]\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))?$/,
  /^gpt-oss-(?:safeguard-)?\d{1,3}b(?:-(?:high|low|medium|xhigh|fast|free))?$/,
  /^o\d{1,2}(?:-(?:mini|pro|preview|high|low|medium|xhigh|fast|batch))?(?:-20[2-3]\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))?$/,
  /^claude-(?:fable|mythos|haiku|opus|sonnet)-\d{1,2}(?:-\d{1,2})?(?:-(?:thinking|fast|batch|high|low|medium|xhigh|max|minimal))*(?:-20[2-3]\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))?$/,
  /^claude-\d{1,2}(?:-\d{1,2})?-(?:fable|mythos|haiku|opus|sonnet)(?:-(?:thinking|fast|batch|high|low|medium|xhigh|max|minimal))*$/,
  /^(?:fable|mythos|haiku|opus|sonnet)(?:-\d{1,2}(?:-\d{1,2})?(?:-(?:thinking|fast|high|low|medium|xhigh|max|minimal))*)?$/,
  /^gemini-\d{1,2}(?:\.\d{1,2})?-(?:pro|flash|ultra|lite|argon|carbon|hydrogen|neon|sonar|exp|preview)(?:-(?:pro|flash|lite|sonar|exp|preview|latest|thinking|customtools|high|low|medium|xhigh|extra|minimal))*(?:-(?:0\d{2}|(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])))?$/,
  /^muse-(?:spark|wonder|ember|glimmer)(?:-\d{1,2}(?:\.\d{1,2})?|-\d{1,3}b)?(?:-(?:open|contributor))?$/,
  /^composer-\d{1,2}(?:\.\d{1,2})?(?:-(?:fast|mini|pro|turbo|preview|latest))?$/,
  /^grok-(?:code|build|\d{1,2}(?:\.\d{1,2})?)(?:-(?:fast|mini|pro|build|beta|latest|reasoning|code))*(?:-\d{1,2}(?:\.\d{1,2})?)?$/,
  /^deepseek-(?:v\d{1,2}(?:[.-]\d{1,2})?|r\d{1,2}(?:[.-]\d{1,2})?|chat|reasoner|coder|flash|pro)(?:-(?:pro|flash|chat|lite|mini|coder|reasoner|distill|thinking|free|latest|fast|preview))*(?:-(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))?$/,
  /^glm-\d{1,2}(?:[.-]\d{1,2})?(?:-(?:air|airx|flash|flashx|plus|pro|turbo|fast|highspeed|free|latest|preview|vision|v))*$/,
  /^qwen-?\d{1,2}(?:\.\d{1,2})?(?:-(?:coder|max|plus|turbo|flash|omni|vl|next|prime))*(?:-\d{1,3}(?:\.\d)?[bt])?(?:-a\d{1,3}b)?(?:-(?:instruct|thinking|preview|latest|free|fast|fp8))*(?:-(?:2[4-9]|3\d)(?:0[1-9]|1[0-2]))?$/,
  /^kimi-(?:k\d{1,2}(?:[.-]\d{1,2})?|for-coding|latest|fast)(?:-(?:pro|code|thinking|preview|latest|fast|highspeed|turbo|free|instruct|256k))*$/,
  /^minimax-m\d{1,2}(?:[.-]\d{1,2})?(?:-(?:flash|pro|fast|highspeed|free|latest|preview))*$/,
  /^(?:mistral|devstral|codestral|ministral|magistral)-(?:large|medium|small|tiny|mini|nemo|saba|latest|\d{1,3}b)(?:-\d{1,2}(?:\.\d{1,2})?)?(?:-\d{1,3}b)?(?:-(?:instruct|latest|preview|free))?(?:-(?:2[4-9]|3\d)(?:0[1-9]|1[0-2]))?$/,
  /^(?:mistral|devstral|codestral|ministral|magistral)-(?:2[4-9]|3\d)(?:0[1-9]|1[0-2])$/,
  /^llama-?\d{1,2}(?:[.-]\d{1,2})?(?:-(?:scout|maverick|vision))?(?:-\d{1,3}b)?(?:-\d{1,2}e)?(?:-(?:instruct|versatile|instant|fast|fp8|preview|latest|free))*$/,
  /^gemma-\d{1,2}(?:\.\d{1,2})?-\d{1,3}b(?:-a\d{1,2}b)?(?:-(?:it|pt|free|latest))*$/,
  /^(?:auto|default)$/,
];

/**
 * Public providers whose own catalog names follow them in a model id, the
 * way agents that reach many providers write it (Pi, OpenCode, fx):
 * `google/gemini-2.5-pro`, `openrouter/anthropic/claude-sonnet-4.5`. Only
 * these prefixes come off. Any other prefix may name a private gateway, and
 * an Azure deployment name is the user's own words, so those stay custom.
 */
const PUBLIC_MODEL_PROVIDER_PREFIXES: ReadonlySet<string> = new Set([
  "alibaba",
  "amazon",
  "amazon-bedrock",
  "anthropic",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "cohere",
  "deepseek",
  "deepseek-ai",
  "fireworks",
  "gemini",
  "github-copilot",
  "google",
  "google-antigravity",
  "google-gemini-cli",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "meta",
  "meta-llama",
  "minimax",
  "minimax-cn",
  "minimaxai",
  "mistral",
  "mistralai",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "qwen",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "qwen-token-plan-individual-cn",
  "spacexai",
  "stepfun",
  "stepfun-ai",
  "tencent",
  "together",
  "vercel",
  "vercel-ai-gateway",
  "x-ai",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "z-ai",
  "zai",
  "zai-coding-cn",
  "zai-org",
]);

/**
 * Every word a public model name may use. Agents let users name their own
 * models (Pi's `models.json`, a Codex custom provider), so
 * `gpt-5.4-acme-payroll` must stay custom even though its shape looks public,
 * with a provider prefix or without. Versions are short numbers (`4o`, `8b`)
 * or dates (`20250929`); a longer number could be an account's. Exact names
 * in KNOWN_SAFE_MODELS need no check.
 */
const PUBLIC_MODEL_WORDS: ReadonlySet<string> = new Set([
  "air",
  "airx",
  "argon",
  "astra",
  "batch",
  "beta",
  // Grok Build's own models: `grok-4.7-build-fast`.
  "build",
  "carbon",
  "chat",
  "claude",
  "code",
  "coder",
  "codestral",
  "codex",
  "coding",
  "composer",
  "contributor",
  "customtools",
  "deepseek",
  "devstral",
  "distill",
  "ember",
  "exp",
  "extra",
  "fable",
  "fast",
  "flash",
  "flashx",
  "for",
  "fp8",
  "free",
  "gemini",
  "gemma",
  "glimmer",
  "glm",
  "gpt",
  "grok",
  "haiku",
  "high",
  "highspeed",
  "hydrogen",
  "instant",
  "instruct",
  "it",
  "kimi",
  "large",
  "latest",
  "lite",
  "llama",
  "low",
  "luna",
  "magistral",
  "maverick",
  "max",
  "medium",
  "mini",
  "minimal",
  "minimax",
  "ministral",
  "mistral",
  "muse",
  "mythos",
  "nano",
  "nemo",
  "neon",
  "next",
  "none",
  "omni",
  "open",
  "opus",
  "oss",
  "plus",
  "preview",
  "prime",
  "pro",
  "pt",
  "qwen",
  "reasoner",
  "reasoning",
  "saba",
  "safeguard",
  "scout",
  "small",
  "sol",
  "sonar",
  "sonnet",
  "spark",
  "terra",
  "thinking",
  "tiny",
  "turbo",
  "ultra",
  "v",
  "versatile",
  "vision",
  "vl",
  "wonder",
  "xhigh",
]);

const SAFE_BRACKET_TRAIT_ENTRY =
  /^(?:1m|(?:reasoning|effort|context|context_size|fast|thinking)=(?:none|minimal|low|medium|high|xhigh|extra-high|max|true|false|\d{1,4}[km]))$/;

const VERSIONED_CLAUDE_SHORTHAND = /^(?:fable|mythos|haiku|opus|sonnet)-\d/;

const PUBLIC_VERSION_TOKEN =
  /^(?:o\d{1,2}|qwen\d{1,2}|llama\d{1,2}|[vrkm]\d{1,2}|\d{1,2}[a-z]?|0\d{2}|\d{1,3}[bkt]|a\d{1,3}b|\d{1,2}e|(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|(?:2[4-9]|3\d)(?:0[1-9]|1[0-2])|20[2-3]\d|20[2-3]\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))$/;

function stripSafeModelSuffixes(bare: string): string {
  let result = bare;
  if (result.endsWith(":free")) {
    result = result.slice(0, -":free".length);
  } else if (result.endsWith(":batch")) {
    result = result.slice(0, -":batch".length);
  }
  const bracketStart = result.indexOf("[");
  if (bracketStart !== -1 && result.endsWith("]")) {
    const inside = result.slice(bracketStart + 1, -1);
    const parts = inside.split(",");
    if (parts.length > 0 && parts.every((part) => SAFE_BRACKET_TRAIT_ENTRY.test(part))) {
      result = result.slice(0, bracketStart);
    }
  }
  return result;
}

/**
 * Exact public bare model ids published in Pi's catalog (excluding Azure, where
 * deployment names are user-chosen, and plain single words like `apex` or
 * `free` that could collide with an arbitrary bare internal name).
 */
const PUBLIC_CATALOG_BARE_MODELS: ReadonlySet<string> = (() => {
  const models = new Set<string>();
  for (const slug of PI_PUBLIC_MODELS) {
    if (slug.startsWith("azure/")) continue;
    const bare = stripSafeModelSuffixes(slug.slice(slug.lastIndexOf("/") + 1));
    if (!bare || (!bare.includes("-") && !/\d/.test(bare))) continue;
    models.add(bare);
  }
  return models;
})();

function normalizeModelString(model: string | null | undefined): string | undefined {
  return model?.trim().toLowerCase() || undefined;
}

function inferModelFamily(model: string | undefined): AnalyticsModelFamily {
  if (!model) return "unknown";
  if (model.includes("claude") || /^(?:fable|mythos|haiku|opus|sonnet)(?:$|[-.])/.test(model)) {
    return "claude";
  }
  if (model.includes("gpt") || /^o\d/.test(model)) return "gpt";
  if (model.includes("gemini")) return "gemini";
  if (model.includes("composer") || model.includes("cursor")) return "cursor";
  if (model.includes("opencode")) return "opencode";
  if (model.startsWith("muse")) return "muse";
  if (model.includes("grok")) return "grok";
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

/**
 * The public name a model id may be reported as, or undefined when it may
 * not. Claude versions get dashes the way Anthropic writes them (GitHub
 * Copilot writes `claude-sonnet-4.5`), and versioned Claude shorthands like
 * `opus-4.6` normalize to `claude-opus-4-6`. A name behind provider prefixes
 * must have only public providers in front and either match a known public
 * pattern (using only public words) or appear verbatim in the pinned public
 * catalog.
 */
function publicModelName(model: string): string | undefined {
  // Too long to report whole, and a cut-off name could hide what made it private.
  if (model.length > MAX_ANALYTICS_MODEL_LENGTH) return undefined;
  const segments = model.split("/");
  const rawBare = segments.pop() ?? "";
  if (!segments.every((segment) => PUBLIC_MODEL_PROVIDER_PREFIXES.has(segment))) {
    return undefined;
  }
  const bare = stripSafeModelSuffixes(rawBare);
  const name = bare.startsWith("claude-")
    ? bare.replaceAll(".", "-")
    : VERSIONED_CLAUDE_SHORTHAND.test(bare)
      ? `claude-${bare.replaceAll(".", "-")}`
      : bare;
  if (
    isSafeKnownModel(name) &&
    (KNOWN_SAFE_MODELS.has(name) ||
      name
        .split(/[-.]/)
        .every((word) => PUBLIC_VERSION_TOKEN.test(word) || PUBLIC_MODEL_WORDS.has(word)))
  ) {
    return name;
  }
  if (PUBLIC_CATALOG_BARE_MODELS.has(bare)) {
    return bare;
  }
  return undefined;
}

/**
 * A model's name when its full `provider/id` slug is on the pinned public
 * catalog (`PI_PUBLIC_MODELS`), covering multi-segment gateway routes (such as
 * Cloudflare Workers AI or OpenRouter vendors) whose inner prefixes are not
 * in `PUBLIC_MODEL_PROVIDER_PREFIXES`. Azure entries apply only to built-in Pi.
 */
function catalogModelName(slug: string, provider?: string): string | undefined {
  if (provider !== "pi" && slug.startsWith("azure/")) return undefined;
  const lastSlash = slug.lastIndexOf("/");
  if (lastSlash === -1) return undefined;
  const prefix = slug.slice(0, lastSlash + 1);
  const rawBare = slug.slice(lastSlash + 1);
  const bare = stripSafeModelSuffixes(rawBare);
  const strippedSlug = `${prefix}${bare}`;
  if (!PI_PUBLIC_MODELS.has(slug) && !PI_PUBLIC_MODELS.has(strippedSlug)) {
    return undefined;
  }
  return publicModelName(bare) ?? bare;
}

export function normalizeAnalyticsModel(
  model: string | null | undefined,
  provider?: string,
): AnalyticsModel {
  const normalized = normalizeModelString(model);
  if (!normalized) {
    return {
      model: "unknown",
      modelKind: "unknown",
      modelFamily: "unknown",
    };
  }

  const name = publicModelName(normalized) ?? catalogModelName(normalized, provider);
  if (name !== undefined) {
    return {
      model: name,
      modelKind: "known",
      modelFamily: inferModelFamily(name),
    };
  }

  return {
    model: "custom",
    modelKind: "custom",
    modelFamily: inferModelFamily(normalized),
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

const isAcpRegistryAgentId = Schema.is(AcpRegistryAgentId);

/**
 * Which agent an event is about: the driver, plus a community agent's public
 * registry id (`pi-acp`), the same id its install event reports, so reports
 * can name it rather than count it with every other agent. The id comes from
 * the instance (`ProviderInstance.communityAgentId`), never from its name.
 */
export function analyticsAgentProperties(input: {
  readonly provider: string;
  readonly communityAgentId?: string | undefined;
  readonly prefix?: string | undefined;
}): Record<string, string> {
  const keyPrefix = input.prefix ?? "";
  const providerKey = keyPrefix ? `${keyPrefix}Provider` : "provider";
  const communityKey = keyPrefix ? `${keyPrefix}CommunityAgentId` : "communityAgentId";
  return input.communityAgentId !== undefined && isAcpRegistryAgentId(input.communityAgentId)
    ? { [providerKey]: input.provider, [communityKey]: input.communityAgentId }
    : { [providerKey]: input.provider };
}

/**
 * Ordered so a provider's own wording wins over generic transport words: the
 * first category with a matching pattern is the one reported. Patterns run
 * against the lowercased message with `_` and `-` read as spaces (so
 * `rate_limit` and `rate-limit` read as "rate limit"), and only the category
 * leaves the machine.
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
      "session limit",
      "hit your limit",
      "purchase more credits",
      "insufficient credit",
      "out of credits",
      "credit balance",
      "payment required",
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
    "execution_limit",
    [
      "max output tokens",
      "maximum output tokens",
      "output token limit",
      "max turns",
      "maximum number of turns",
      "budget exceeded",
      "budget exhausted",
    ],
  ],
  [
    "context_length",
    [
      "context length",
      "context window",
      "maximum context",
      "too many tokens",
      "token limit",
      "prompt is too long",
      "prompt too long",
    ],
  ],
  ["overloaded", ["at capacity", "overloaded", /\b529\b/, /\b503\b/, "service unavailable"]],
  [
    "model_unavailable",
    [
      "model unavailable",
      "model not available",
      "model not found",
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
      "connection dropped",
      "disconnected",
      "error sending request",
      "socket hang up",
    ],
  ],
  // After network, whose "connection refused" is not a model refusing.
  ["refusal", ["refused", "refusal", "content filter", "content policy", "usage policy"]],
  [
    "process_exit",
    ["process exited", "exited with code", "exited unexpectedly", "sigterm", "sigkill"],
  ],
  ["missing_directory", ["does not exist", "no longer exists", "no such file or directory"]],
  // Late: "internal error" often wraps a more specific cause named in the same message.
  ["server_error", ["internal server error", "internal error", "server error", "bad gateway"]],
  ["permission", ["permission", "not allowed", "access denied", "sandbox"]],
  ["validation", ["invalid request", "bad request", "validation"]],
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
    .replace(BARE_PATH_PATTERN, " ")
    .replace(/[_-]/g, " ");
}

/**
 * The category a failure is reported under. The driver's structured category
 * wins; the error class and the message wording fill in when it has none.
 */
export function classifyProviderFailure(input: {
  readonly category?: ProviderFailureCategory | undefined;
  readonly errorClass?: string | undefined;
  readonly message?: string | null | undefined;
  readonly reason?: string | null | undefined;
}): AnalyticsFailureCategory {
  if (input.category !== undefined) {
    return input.category;
  }
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

/**
 * Property prefixes for every driver. Community agents share one prefix, so it
 * says whether any of them is on, installed or signed in, never which one.
 */
const READINESS_DRIVER_KEYS: Readonly<Record<string, string>> = {
  acpRegistry: "communityAgent",
  antigravity: "antigravity",
  claudeAgent: "claude",
  codex: "codex",
  cursor: "cursor",
  fx: "fx",
  grok: "grok",
  muse: "muse",
  opencode: "opencode",
  pi: "pi",
};

/** Same order of evidence the Settings status line uses. */
export function providerSignInState(snapshot: ServerProvider): AnalyticsSignInState {
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
 * versions never leave. `options.signInState` reads each provider's sign-in;
 * the reporter passes one that remembers the last answer a check could give.
 */
export function providerReadinessProperties(
  providers: ReadonlyArray<ServerProvider>,
  options?: {
    readonly signInState?: (provider: ServerProvider) => AnalyticsSignInState;
  },
): Record<string, string | boolean> {
  const signInState = options?.signInState ?? providerSignInState;
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

/**
 * What a theme event says about the theme (docs/telemetry.md): who made it
 * (an agent, a file, a copy of a starter), light or dark, the kind of live
 * art or none, and whether it sets its own fonts. Never its name, prompt,
 * colors, art or fonts.
 */
export function themeAnalyticsProperties(manifest: ThemeManifest) {
  const origin =
    manifest.createdBy?.vscode !== undefined || manifest.credits?.vscode !== undefined
      ? "vscode"
      : (manifest.createdBy?.kind ?? "unknown");
  return {
    origin,
    base: manifest.base,
    art: manifest.backdrop?.mode ?? "none",
    customFonts: manifest.fonts?.ui !== undefined || manifest.fonts?.mono !== undefined,
  };
}

export type AnalyticsStallDurationBucket = "2-5s" | "5-15s" | "15s+";

export function stallDurationBucket(durationMs: number): AnalyticsStallDurationBucket {
  if (durationMs >= 15_000) return "15s+";
  if (durationMs >= 5_000) return "5-15s";
  return "2-5s";
}
