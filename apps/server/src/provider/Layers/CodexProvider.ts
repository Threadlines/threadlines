import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Types from "effect/Types";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as CodexErrors from "effect-codex-app-server/errors";

import type {
  CodexSettings,
  ServerProvider,
  ServerProviderAccountUsage,
  ServerProviderAccountTokenUsage,
  ServerProviderRateLimitResetCredits,
  ServerProviderSpendControlLimit,
  ServerProviderUsageCredits,
  ServerProviderUsageLimit,
  ServerProviderUsageWindow,
  ServerProviderState,
  ModelCapabilities,
  ModelInputModality,
  ModelUpgradeInfo,
  ServerProviderModel,
  ServerProviderSkill,
} from "@threadlines/contracts";
import { RUNTIME_MODES, ServerSettingsError } from "@threadlines/contracts";

import { createModelCapabilities } from "@threadlines/shared/model";
import { isCommandAvailable } from "@threadlines/shared/shell";
import { DEFAULT_CODEX_SERVICE_TIER_SELECTION } from "../../codexServiceTier.ts";
import { CODEX_APP_SERVER_ARGS, codexAppServerCommandOptions } from "../codexAppServerArgs.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import packageJson from "../../../package.json" with { type: "json" };
const isCodexAppServerSpawnError = Schema.is(CodexErrors.CodexAppServerSpawnError);

const CODEX_PRESENTATION = {
  displayName: "Codex",
  showInteractionModeToggle: true,
  supportedRuntimeModes: RUNTIME_MODES,
} as const;

const CODEX_PROVIDER_PENDING_MESSAGE = "Checking Codex provider status.";
const CODEX_PROVIDER_TIMEOUT_MESSAGE =
  "Codex status check timed out after 60 seconds. Existing sessions may still work; refresh provider status if this keeps happening.";

export interface CodexAppServerProviderSnapshot {
  readonly account: CodexSchema.V2GetAccountResponse;
  readonly rateLimits?: CodexSchema.V2GetAccountRateLimitsResponse;
  readonly tokenUsage?: CodexSchema.V2GetAccountTokenUsageResponse;
  readonly version: string | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

const REASONING_EFFORT_LABELS: Record<CodexSchema.V2ModelListResponse__ReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

const DEFAULT_CODEX_SERVICE_TIER_LABEL = "Standard";
const DEFAULT_CODEX_INPUT_MODALITIES: ReadonlyArray<ModelInputModality> = ["text", "image"];
const CODEX_FAST_MODE_DESCRIPTION = "1.5x speed. Increased usage.";

function titleCaseIdentifier(value: string): string {
  const words = value.trim().replace(/[_-]+/g, " ");
  if (words.length === 0) return "Unknown";
  return words.replace(/\b\w/g, (char) => char.toUpperCase());
}

function reasoningEffortLabel(reasoningEffort: string): string {
  return REASONING_EFFORT_LABELS[reasoningEffort] ?? titleCaseIdentifier(reasoningEffort);
}

function codexAccountAuthLabel(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account) return undefined;
  if (account.type === "apiKey") return "OpenAI API Key";
  if (account.type === "amazonBedrock") return "Amazon Bedrock";
  if (account.type !== "chatgpt") return undefined;

  switch (account.planType) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro 20x Subscription";
    case "prolite":
      return "ChatGPT Pro 5x Subscription";
    case "team":
      return "ChatGPT Team Subscription";
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      account.planType satisfies never;
      return undefined;
  }
}

function codexAccountEmail(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account || account.type !== "chatgpt") return undefined;
  return account.email;
}

function optionalString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function optionalNonNegativeInt(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function normalizeUsagePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeCodexUsageWindow(
  window: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow | null | undefined,
): ServerProviderUsageWindow | undefined {
  if (!window) return undefined;

  const usedPercent = normalizeUsagePercent(window.usedPercent);
  const resetsAt = optionalNonNegativeInt(window.resetsAt);
  const windowDurationMins = optionalNonNegativeInt(window.windowDurationMins);
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
  };
}

function normalizeCodexUsageCredits(
  credits: CodexSchema.V2GetAccountRateLimitsResponse__CreditsSnapshot | null | undefined,
): ServerProviderUsageCredits | undefined {
  if (!credits) return undefined;

  const balance = optionalString(credits.balance);
  return {
    hasCredits: credits.hasCredits,
    unlimited: credits.unlimited,
    ...(balance ? { balance } : {}),
  };
}

function normalizeCodexRateLimitResetCredits(
  credits: CodexSchema.V2GetAccountRateLimitsResponse["rateLimitResetCredits"],
): ServerProviderRateLimitResetCredits | undefined {
  if (!credits) return undefined;

  const availableCount = Number(credits.availableCount);
  if (!Number.isInteger(availableCount) || availableCount < 0) {
    return undefined;
  }

  const detailedCredits = Array.isArray(credits.credits)
    ? credits.credits.flatMap((credit) => {
        const id = optionalString(credit.id);
        const grantedAt = Number(credit.grantedAt);
        const expiresAt = credit.expiresAt == null ? undefined : Number(credit.expiresAt);
        if (
          !id ||
          !Number.isSafeInteger(grantedAt) ||
          grantedAt < 0 ||
          (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt < 0))
        ) {
          return [];
        }

        const title = optionalString(credit.title);
        const description = optionalString(credit.description);
        return [
          {
            id,
            resetType: credit.resetType,
            status: credit.status,
            grantedAt,
            ...(expiresAt !== undefined ? { expiresAt } : {}),
            ...(title ? { title } : {}),
            ...(description ? { description } : {}),
          },
        ];
      })
    : undefined;

  return {
    availableCount,
    ...(detailedCredits ? { credits: detailedCredits } : {}),
  };
}

function supportsCodexSpendControlLimit(
  planType: CodexSchema.V2GetAccountRateLimitsResponse__PlanType | null | undefined,
): boolean {
  return (
    planType === "enterprise" || planType === "enterprise_cbp_usage_based" || planType === "edu"
  );
}

function normalizeCodexSpendControlLimit(
  limit: CodexSchema.V2GetAccountRateLimitsResponse__SpendControlLimitSnapshot | null | undefined,
): ServerProviderSpendControlLimit | undefined {
  if (!limit) return undefined;

  const normalizedLimit = optionalString(limit.limit);
  const used = optionalString(limit.used);
  if (!normalizedLimit || !used) {
    return undefined;
  }

  const resetsAt = optionalNonNegativeInt(limit.resetsAt);
  return {
    limit: normalizedLimit,
    used,
    remainingPercent: normalizeUsagePercent(limit.remainingPercent),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function normalizeCodexUsageLimit(
  snapshot: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitSnapshot,
  fallbackLimitId?: string,
): ServerProviderUsageLimit | undefined {
  const limitId = optionalString(snapshot.limitId) ?? optionalString(fallbackLimitId);
  const limitName = optionalString(snapshot.limitName);
  const planType = optionalString(snapshot.planType);
  const rateLimitReachedType = optionalString(snapshot.rateLimitReachedType);
  const credits = normalizeCodexUsageCredits(snapshot.credits);
  const individualLimit = supportsCodexSpendControlLimit(snapshot.planType)
    ? normalizeCodexSpendControlLimit(snapshot.individualLimit)
    : undefined;
  const primary = normalizeCodexUsageWindow(snapshot.primary);
  const secondary = normalizeCodexUsageWindow(snapshot.secondary);

  if (
    !limitId &&
    !limitName &&
    !planType &&
    !rateLimitReachedType &&
    !credits &&
    !individualLimit &&
    !primary &&
    !secondary
  ) {
    return undefined;
  }

  return {
    ...(limitId ? { limitId } : {}),
    ...(limitName ? { limitName } : {}),
    ...(planType ? { planType } : {}),
    ...(rateLimitReachedType ? { rateLimitReachedType } : {}),
    ...(credits ? { credits } : {}),
    ...(individualLimit ? { individualLimit } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

function normalizeCodexTokenUsage(
  tokenUsage: CodexSchema.V2GetAccountTokenUsageResponse | undefined,
  checkedAt: string,
): ServerProviderAccountTokenUsage | undefined {
  if (!tokenUsage) return undefined;

  const dailyBuckets = (tokenUsage.dailyUsageBuckets ?? [])
    .map((bucket) => {
      const startDate = optionalString(bucket.startDate);
      const tokens = optionalNonNegativeInt(bucket.tokens);
      return startDate && tokens !== undefined ? { startDate, tokens } : undefined;
    })
    .filter((bucket): bucket is { readonly startDate: string; readonly tokens: number } =>
      Boolean(bucket),
    )
    .toSorted((left, right) => left.startDate.localeCompare(right.startDate))
    .slice(-30);

  const summary = {
    ...(optionalNonNegativeInt(tokenUsage.summary.currentStreakDays) !== undefined
      ? { currentStreakDays: optionalNonNegativeInt(tokenUsage.summary.currentStreakDays) }
      : {}),
    ...(optionalNonNegativeInt(tokenUsage.summary.lifetimeTokens) !== undefined
      ? { lifetimeTokens: optionalNonNegativeInt(tokenUsage.summary.lifetimeTokens) }
      : {}),
    ...(optionalNonNegativeInt(tokenUsage.summary.longestRunningTurnSec) !== undefined
      ? { longestRunningTurnSec: optionalNonNegativeInt(tokenUsage.summary.longestRunningTurnSec) }
      : {}),
    ...(optionalNonNegativeInt(tokenUsage.summary.longestStreakDays) !== undefined
      ? { longestStreakDays: optionalNonNegativeInt(tokenUsage.summary.longestStreakDays) }
      : {}),
    ...(optionalNonNegativeInt(tokenUsage.summary.peakDailyTokens) !== undefined
      ? { peakDailyTokens: optionalNonNegativeInt(tokenUsage.summary.peakDailyTokens) }
      : {}),
  };

  if (dailyBuckets.length === 0 && Object.keys(summary).length === 0) {
    return undefined;
  }

  return {
    checkedAt,
    dailyBuckets,
    summary,
  };
}

function normalizeCodexAccountUsage(
  rateLimits: CodexSchema.V2GetAccountRateLimitsResponse | undefined,
  tokenUsage: CodexSchema.V2GetAccountTokenUsageResponse | undefined,
  checkedAt: string,
): ServerProviderAccountUsage | undefined {
  const limits: ServerProviderUsageLimit[] = [];
  const seen = new Set<string>();
  const rateLimitResetCredits = normalizeCodexRateLimitResetCredits(
    rateLimits?.rateLimitResetCredits,
  );
  const appendLimit = (
    snapshot: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitSnapshot,
    fallbackLimitId?: string,
  ) => {
    const normalized = normalizeCodexUsageLimit(snapshot, fallbackLimitId);
    if (!normalized) return;

    const key = normalized.limitId ?? normalized.limitName ?? `limit-${limits.length}`;
    if (seen.has(key)) return;
    seen.add(key);
    limits.push(normalized);
  };

  if (rateLimits) {
    appendLimit(rateLimits.rateLimits);
  }
  const byLimitId = rateLimits?.rateLimitsByLimitId ?? {};
  for (const [limitId, snapshot] of Object.entries(byLimitId)) {
    appendLimit(snapshot, limitId);
  }

  const normalizedTokenUsage = normalizeCodexTokenUsage(tokenUsage, checkedAt);
  if (limits.length === 0 && !rateLimitResetCredits && !normalizedTokenUsage) return undefined;

  const primaryLimitId =
    optionalString(rateLimits?.rateLimits.limitId) ??
    limits.find((limit) => limit.limitId)?.limitId;
  return {
    source: "codex-rate-limits",
    checkedAt,
    ...(primaryLimitId ? { primaryLimitId } : {}),
    ...(rateLimitResetCredits ? { rateLimitResetCredits } : {}),
    limits,
    ...(normalizedTokenUsage ? { tokenUsage: normalizedTokenUsage } : {}),
  };
}

/**
 * Fold a sparse `account/rateLimits/updated` notification into the usage
 * snapshot from the last full probe. Per the app-server protocol, rolling
 * updates carry only changed values and must be merged into the most recent
 * `account/rateLimits/read` response. Returns `undefined` when the
 * notification carries nothing usable.
 */
export function mergeCodexAccountUsageRateLimits(
  current: ServerProviderAccountUsage | undefined,
  rateLimits: CodexSchema.V2AccountRateLimitsUpdatedNotification["rateLimits"],
  checkedAt: string,
): ServerProviderAccountUsage | undefined {
  const sparseLimit = normalizeCodexUsageLimit(rateLimits);
  if (!sparseLimit) return undefined;

  if (!current) {
    return {
      source: "codex-rate-limits",
      checkedAt,
      ...(sparseLimit.limitId ? { primaryLimitId: sparseLimit.limitId } : {}),
      limits: [sparseLimit],
    };
  }

  // An update with a limit id merges into that limit (or appends when the
  // limit is new). An id-less update refers to the account's main limit —
  // the primary limit when known, otherwise the first.
  let limitIndex: number;
  if (sparseLimit.limitId !== undefined) {
    limitIndex = current.limits.findIndex((limit) => limit.limitId === sparseLimit.limitId);
  } else if (current.primaryLimitId !== undefined) {
    const primaryIndex = current.limits.findIndex(
      (limit) => limit.limitId === current.primaryLimitId,
    );
    limitIndex = primaryIndex >= 0 ? primaryIndex : current.limits.length > 0 ? 0 : -1;
  } else {
    limitIndex = current.limits.length > 0 ? 0 : -1;
  }
  const limits =
    limitIndex === -1
      ? [...current.limits, sparseLimit]
      : current.limits.map((limit, index) =>
          index === limitIndex ? { ...limit, ...sparseLimit } : limit,
        );
  return {
    ...current,
    checkedAt,
    limits,
  };
}

function mapCodexModelCapabilities(
  model: CodexSchema.V2ModelListResponse__Model,
): ModelCapabilities {
  const reasoningOptions = model.supportedReasoningEfforts.map(
    ({ reasoningEffort, description }) => {
      const normalizedDescription = optionalString(description);
      return {
        id: reasoningEffort,
        label: reasoningEffortLabel(reasoningEffort),
        ...(normalizedDescription ? { description: normalizedDescription } : {}),
        ...(reasoningEffort === model.defaultReasoningEffort ? { isDefault: true } : {}),
      };
    },
  );
  const defaultReasoning = reasoningOptions.find((option) => option.isDefault)?.id;
  const serviceTierOptions = mapCodexServiceTierOptions(model);
  const defaultServiceTier = serviceTierOptions.find((option) => option.isDefault)?.id;
  const supportsLegacyFastMode =
    serviceTierOptions.length === 0 && (model.additionalSpeedTiers ?? []).includes("fast");
  const inputModalities = (model.inputModalities ?? DEFAULT_CODEX_INPUT_MODALITIES).filter(
    (modality): modality is "text" | "image" => modality === "text" || modality === "image",
  );
  return createModelCapabilities({
    inputModalities,
    supportsPersonality: model.supportsPersonality ?? false,
    optionDescriptors: [
      ...(reasoningOptions.length > 0
        ? [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select" as const,
              options: reasoningOptions,
              ...(defaultReasoning ? { currentValue: defaultReasoning } : {}),
            },
          ]
        : []),
      ...(serviceTierOptions.length > 0
        ? [
            {
              id: "serviceTier",
              label: "Speed",
              description: CODEX_FAST_MODE_DESCRIPTION,
              type: "select" as const,
              options: serviceTierOptions,
              ...(defaultServiceTier ? { currentValue: defaultServiceTier } : {}),
            },
          ]
        : []),
      ...(supportsLegacyFastMode
        ? [
            {
              id: "fastMode",
              label: "Fast Mode",
              description: CODEX_FAST_MODE_DESCRIPTION,
              type: "boolean" as const,
            },
          ]
        : []),
    ],
  });
}

function mapCodexModelUpgradeInfo(
  upgradeInfo: CodexSchema.V2ModelListResponse__ModelUpgradeInfo | null | undefined,
): ModelUpgradeInfo | undefined {
  const model = optionalString(upgradeInfo?.model);
  if (!model) {
    return undefined;
  }

  const mapped: Types.Mutable<ModelUpgradeInfo> = { model };
  const modelLink = optionalString(upgradeInfo?.modelLink);
  const upgradeCopy = optionalString(upgradeInfo?.upgradeCopy);
  const migrationMarkdown = optionalString(upgradeInfo?.migrationMarkdown);
  if (modelLink) mapped.modelLink = modelLink;
  if (upgradeCopy) mapped.upgradeCopy = upgradeCopy;
  if (migrationMarkdown) mapped.migrationMarkdown = migrationMarkdown;
  return mapped;
}

function mapCodexServiceTierOptions(model: CodexSchema.V2ModelListResponse__Model) {
  const serviceTiers = model.serviceTiers ?? [];
  if (serviceTiers.length === 0) {
    return [];
  }

  const configuredDefaultServiceTier = optionalString(model.defaultServiceTier);
  const hasConfiguredDefaultServiceTier =
    configuredDefaultServiceTier !== undefined &&
    serviceTiers.some((tier) => tier.id === configuredDefaultServiceTier);
  const defaultOption: {
    id: string;
    label: string;
    isDefault?: true;
  } = {
    id: DEFAULT_CODEX_SERVICE_TIER_SELECTION,
    label: DEFAULT_CODEX_SERVICE_TIER_LABEL,
  };
  if (!hasConfiguredDefaultServiceTier) {
    defaultOption.isDefault = true;
  }

  return [
    defaultOption,
    ...serviceTiers.map((tier) => {
      const description = optionalString(tier.description);
      const option: {
        id: string;
        label: string;
        description?: string;
        isDefault?: true;
      } = {
        id: tier.id,
        label: tier.name,
      };
      if (description) {
        option.description = description;
      }
      if (tier.id === configuredDefaultServiceTier) {
        option.isDefault = true;
      }
      return option;
    }),
  ];
}

const toDisplayName = (model: CodexSchema.V2ModelListResponse__Model): string => {
  // Capitalize 'gpt' to 'GPT-' and capitalize any letter following a dash
  return model.displayName
    .replace(/^gpt/i, "GPT") // Handle start with 'gpt' or 'GPT'
    .replace(/-([a-z])/g, (_, c) => "-" + c.toUpperCase());
};

export function parseCodexModelListResponse(
  response: CodexSchema.V2ModelListResponse,
): ReadonlyArray<ServerProviderModel> {
  return response.data.map((model) => {
    const mapped: Types.Mutable<ServerProviderModel> = {
      slug: model.model,
      name: toDisplayName(model),
      isCustom: false,
      capabilities: mapCodexModelCapabilities(model),
    };
    const description = optionalString(model.description);
    const availabilityMessage = optionalString(model.availabilityNux?.message);
    const upgrade = optionalString(model.upgrade);
    const upgradeInfo = mapCodexModelUpgradeInfo(model.upgradeInfo);
    if (description) mapped.description = description;
    if (model.isDefault) mapped.isDefault = true;
    if (model.hidden) mapped.isHidden = true;
    if (availabilityMessage) mapped.availabilityMessage = availabilityMessage;
    if (upgrade) mapped.upgrade = upgrade;
    if (upgradeInfo) mapped.upgradeInfo = upgradeInfo;
    return mapped;
  });
}

function appendCustomCodexModels(
  models: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  if (customModels.length === 0) {
    return models;
  }

  const seen = new Set(models.map((model) => model.slug));
  const fallbackCapabilities = models.find((model) => model.capabilities)?.capabilities ?? null;
  const customEntries: ServerProviderModel[] = [];
  for (const rawModel of customModels) {
    const slug = rawModel.trim();
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    customEntries.push({
      slug,
      name: slug,
      isCustom: true,
      capabilities: fallbackCapabilities,
    });
  }
  return customEntries.length === 0 ? models : [...models, ...customEntries];
}

function parseCodexSkillsListResponse(
  response: CodexSchema.V2SkillsListResponse,
  cwd: string,
): ReadonlyArray<ServerProviderSkill> {
  const matchingEntry = response.data.find((entry) => entry.cwd === cwd);
  const skills = matchingEntry
    ? matchingEntry.skills
    : response.data.flatMap((entry) => entry.skills);

  return skills.map((skill) => {
    const shortDescription =
      skill.shortDescription ?? skill.interface?.shortDescription ?? undefined;

    const parsedSkill: Types.Mutable<ServerProviderSkill> = {
      name: skill.name,
      path: skill.path,
      enabled: skill.enabled,
    };

    if (skill.description) {
      parsedSkill.description = skill.description;
    }
    if (skill.scope) {
      parsedSkill.scope = skill.scope;
    }
    if (skill.interface?.displayName) {
      parsedSkill.displayName = skill.interface.displayName;
    }
    if (shortDescription) {
      parsedSkill.shortDescription = shortDescription;
    }

    return parsedSkill;
  });
}

const requestAllCodexModels = Effect.fn("requestAllCodexModels")(function* (
  client: CodexClient.CodexAppServerClientShape,
) {
  const models: ServerProviderModel[] = [];
  let cursor: string | null | undefined = undefined;

  do {
    const response: CodexSchema.V2ModelListResponse = yield* client.request(
      "model/list",
      cursor ? { cursor } : {},
    );
    models.push(...parseCodexModelListResponse(response));
    cursor = response.nextCursor;
  } while (cursor);

  return models;
});

export function buildCodexInitializeParams(): CodexSchema.V1InitializeParams {
  return {
    clientInfo: {
      name: "threadlines_desktop",
      title: "Threadlines Desktop",
      version: packageJson.version,
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

const makeCodexAppServerClient = Effect.fn("makeCodexAppServerClient")(function* (input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  if (!isCommandAvailable(input.binaryPath, { env: input.environment ?? process.env })) {
    return yield* new CodexErrors.CodexAppServerSpawnError({
      command: [input.binaryPath, ...CODEX_APP_SERVER_ARGS].join(" "),
      cause: new Error("Codex CLI is not available on PATH."),
    });
  }

  // `~` is not shell-expanded when env vars are set via `child_process.spawn`,
  // so `CODEX_HOME=~/.codex_work` would reach codex verbatim and trip
  // "CODEX_HOME points to '~/.codex_work', but that path does not exist".
  // Expand here for parity with `CodexTextGeneration`/`CodexSessionRuntime`.
  const resolvedHomePath = input.homePath ? expandHomePath(input.homePath) : undefined;
  const clientContext = yield* Layer.build(
    CodexClient.layerCommand({
      ...codexAppServerCommandOptions(input.binaryPath, input.environment),
      cwd: input.cwd,
      env: {
        ...(input.environment ?? process.env),
        ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
      },
    }),
  );
  return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );
});

const initializeCodexAppServerClient = Effect.fn("initializeCodexAppServerClient")(function* (
  client: CodexClient.CodexAppServerClientShape,
) {
  const initialize = yield* client.request("initialize", buildCodexInitializeParams());
  yield* client.notify("initialized", undefined);
  return initialize;
});

const probeCodexAppServerProvider = Effect.fn("probeCodexAppServerProvider")(function* (input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly cwd: string;
  readonly customModels?: ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const client = yield* makeCodexAppServerClient(input);
  const initialize = yield* initializeCodexAppServerClient(client);

  // Extract the version string after the first '/' in userAgent, up to the next space or the end
  const versionMatch = initialize.userAgent.match(/\/([^\s]+)/);
  const version = versionMatch ? versionMatch[1] : undefined;

  const accountResponse = yield* client.request("account/read", {});
  if (!accountResponse.account && accountResponse.requiresOpenaiAuth) {
    return {
      account: accountResponse,
      version,
      models: appendCustomCodexModels([], input.customModels ?? []),
      skills: [],
    } satisfies CodexAppServerProviderSnapshot;
  }

  const [skillsResponse, models, rateLimits, tokenUsage] = yield* Effect.all(
    [
      client.request("skills/list", {
        cwds: [input.cwd],
      }),
      requestAllCodexModels(client),
      client
        .request("account/rateLimits/read", undefined)
        .pipe(Effect.orElseSucceed(() => undefined)),
      client.request("account/usage/read", undefined).pipe(Effect.orElseSucceed(() => undefined)),
    ],
    { concurrency: "unbounded" },
  );

  return {
    account: accountResponse,
    ...(rateLimits ? { rateLimits } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    version,
    models: appendCustomCodexModels(models, input.customModels ?? []),
    skills: parseCodexSkillsListResponse(skillsResponse, input.cwd),
  } satisfies CodexAppServerProviderSnapshot;
});

export const consumeCodexRateLimitResetCredit = Effect.fn("consumeCodexRateLimitResetCredit")(
  function* (input: {
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly cwd: string;
    readonly idempotencyKey: string;
    readonly creditId?: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) {
    const client = yield* makeCodexAppServerClient(input);
    yield* initializeCodexAppServerClient(client);
    return yield* client.request("account/rateLimitResetCredit/consume", {
      idempotencyKey: input.idempotencyKey,
      ...(input.creditId ? { creditId: input.creditId } : {}),
    });
  },
);

const emptyCodexModelsFromSettings = (codexSettings: CodexSettings): ServerProvider["models"] =>
  codexSettings.customModels
    .map((model) => model.trim())
    .filter((model, index, models) => model.length > 0 && models.indexOf(model) === index)
    .map((model) => ({
      slug: model,
      name: model,
      isCustom: true,
      capabilities: null,
    }));

const makePendingCodexProvider = (
  codexSettings: CodexSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = emptyCodexModelsFromSettings(codexSettings);

    if (!codexSettings.enabled) {
      return buildServerProvider({
        presentation: CODEX_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        skills: [],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Codex is disabled in Threadlines settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        statusReason: "provider_probe_pending",
        auth: { status: "unknown" },
        message: CODEX_PROVIDER_PENDING_MESSAGE,
      },
    });
  });

function accountProbeStatus(account: CodexAppServerProviderSnapshot["account"]): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProvider["auth"];
  readonly message?: string;
} {
  const authLabel = codexAccountAuthLabel(account.account);
  const authEmail = codexAccountEmail(account.account);
  const auth = {
    status: account.account ? ("authenticated" as const) : ("unknown" as const),
    ...(account.account?.type ? { type: account.account?.type } : {}),
    ...(authLabel ? { label: authLabel } : {}),
    ...(authEmail ? { email: authEmail } : {}),
  } satisfies ServerProvider["auth"];

  if (account.account) {
    return { status: "ready", auth };
  }

  if (account.requiresOpenaiAuth) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  return { status: "ready", auth };
}

export const checkCodexProviderStatus = Effect.fn("checkCodexProviderStatus")(function* (
  codexSettings: CodexSettings,
  probe: (input: {
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly cwd: string;
    readonly customModels: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<
    CodexAppServerProviderSnapshot,
    CodexErrors.CodexAppServerError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  > = probeCodexAppServerProvider,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  ServerSettingsError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const emptyModels = emptyCodexModelsFromSettings(codexSettings);

  if (!codexSettings.enabled) {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: false,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex is disabled in Threadlines settings.",
      },
    });
  }

  const probeResult = yield* probe({
    binaryPath: codexSettings.binaryPath,
    homePath: codexSettings.homePath,
    cwd: process.cwd(),
    customModels: codexSettings.customModels,
    environment,
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(AUTH_PROBE_TIMEOUT_MS)),
    Effect.result,
  );

  if (Result.isFailure(probeResult)) {
    const error = probeResult.failure;
    const installed = !isCodexAppServerSpawnError(error);
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: installed
          ? `Codex app-server provider probe failed: ${error.message}.`
          : "Codex CLI (`codex`) is not installed or not on PATH. Install it from https://developers.openai.com/codex/cli and run `codex login`.",
      },
    });
  }

  if (Option.isNone(probeResult.success)) {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: true,
        version: null,
        status: "warning",
        statusReason: "provider_probe_timeout",
        auth: { status: "unknown" },
        message: CODEX_PROVIDER_TIMEOUT_MESSAGE,
      },
    });
  }

  const snapshot = probeResult.success.value;
  const accountStatus = accountProbeStatus(snapshot.account);
  const accountUsage = normalizeCodexAccountUsage(
    snapshot.rateLimits,
    snapshot.tokenUsage,
    checkedAt,
  );

  return buildServerProvider({
    presentation: CODEX_PRESENTATION,
    enabled: codexSettings.enabled,
    checkedAt,
    models: snapshot.models,
    skills: snapshot.skills,
    probe: {
      installed: true,
      version: snapshot.version ?? null,
      status: accountStatus.status,
      auth: accountStatus.auth,
      ...(accountUsage ? { accountUsage } : {}),
      ...(accountStatus.message ? { message: accountStatus.message } : {}),
    },
  });
});

// NOTE: the singleton `CodexProviderLive` Layer has been removed as part of
// the per-instance-driver refactor. `CodexDriver.create()` builds a managed
// snapshot per instance (each with its own `CodexSettings`) and hands the
// resulting `ServerProviderShape` back as `ProviderInstance.snapshot`.
//
// The `makePendingCodexProvider` and `checkCodexProviderStatus` helpers are
// re-exported for use by `CodexDriver`.
export { makePendingCodexProvider };
