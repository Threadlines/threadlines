/**
 * OpenCodeProvider — the OpenCode 2 provider snapshot: install, version,
 * models, slash commands and skills.
 *
 * Models come from the running server, so the catalog is exactly what the
 * user's OpenCode can use right now. OpenCode has no "signed in" flag: with no
 * credentials it still serves its free Zen models, so a catalog of only those
 * is ready but nudges the user to connect a provider.
 *
 * @module provider/Layers/OpenCodeProvider
 */
import {
  type ModelCapabilities,
  type OpenCodeSettings,
  ProviderDriverKind,
  type RuntimeUsageLimit,
  type ServerProviderAccountUsage,
  type ServerProviderDetection,
  type ServerProviderModel,
  type ServerProviderScopedUsageWindow,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
  type ServerProviderSpendControlLimit,
  type ServerProviderUsageWindow,
} from "@threadlines/contracts";
import { createModelCapabilities } from "@threadlines/shared/model";
import { usageLimitFromAccountUsage, usageResetTimeMs } from "@threadlines/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { ChildProcessSpawner } from "effect/process";

import {
  type OpenCodeClient,
  OpenCodeError,
  openCodeErrorStatus,
  runOpenCode,
} from "../opencode/OpenCodeClient.ts";
import {
  isOpenCodeNotInstalledError,
  isOpenCodeOneVersion,
  isSupportedOpenCodeVersion,
  MINIMUM_OPENCODE_VERSION,
  probeOpenCodeVersion,
} from "../opencode/OpenCodeServer.ts";
import { detectOpenCodeBinary, OPENCODE_INSTALL_COMMAND } from "../opencode/OpenCodeBinary.ts";
import type { OpenCodeServerManagerShape } from "../opencode/OpenCodeServerManager.ts";
import { undetectableProvider } from "../providerDetection.ts";
import {
  buildServerProvider,
  cliStartFailureFrom,
  nonEmptyTrimmed,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
  withStartFailureReason,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("opencode");

export const OPENCODE_PRESENTATION = {
  displayName: "OpenCode",
  showInteractionModeToggle: true,
} as const;

const CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/** OpenCode's own provider; without a key it serves only its free models. */
const OPENCODE_ZEN_PROVIDER = "opencode";
const GO_ROLLING_WINDOW_MINS = 5 * 60;
const GO_WEEKLY_WINDOW_MINS = 7 * 24 * 60;
const GO_MONTHLY_WINDOW_MINS = 30 * 24 * 60;

function titleCase(value: string): string {
  return value
    .split(/[-_]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function formatOpenCodeUsdPerM(usdPerM: number): string {
  const rendered =
    usdPerM >= 100
      ? usdPerM.toFixed(0)
      : usdPerM >= 1
        ? usdPerM.toFixed(2)
        : usdPerM.toPrecision(2);
  return `$${rendered.replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1")}/M`;
}

function formatOpenCodeUsd(usd: number): string {
  return `$${Math.max(0, usd).toFixed(2)}`;
}

function formatOpenCodeContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number(millions.toFixed(1))}M ctx`;
  }
  const thousands = tokens % 1024 === 0 ? tokens / 1024 : Math.round(tokens / 1000);
  return `${thousands}K ctx`;
}

export interface OpenCodeModelMetaInput {
  readonly providerID: string;
  readonly cost?: ReadonlyArray<{
    readonly tier?: unknown;
    readonly input: number;
    readonly output: number;
  }>;
  readonly limit?: {
    readonly context?: number;
    readonly input?: number;
  };
}

/** Compact context window and per-M pricing line, plus a "Free" chip for free Zen models. */
export function openCodeModelMeta(model: OpenCodeModelMetaInput): {
  readonly metaLabel?: string;
  readonly promoLabel?: string;
} {
  const baseCost = (model.cost ?? []).find((tier) => tier.tier === undefined) ?? model.cost?.[0];
  const hasPricing =
    baseCost !== undefined &&
    Number.isFinite(baseCost.input) &&
    Number.isFinite(baseCost.output) &&
    baseCost.input >= 0 &&
    baseCost.output >= 0;
  const isZeroCost = hasPricing && baseCost.input === 0 && baseCost.output === 0;
  const isFreeZen = isZeroCost && model.providerID === OPENCODE_ZEN_PROVIDER;
  const contextTokens = model.limit?.input ?? model.limit?.context;
  const parts = [
    ...(typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens > 0
      ? [formatOpenCodeContextWindow(contextTokens)]
      : []),
    ...(hasPricing && !isZeroCost
      ? [
          `${formatOpenCodeUsdPerM(baseCost.input)} in`,
          `${formatOpenCodeUsdPerM(baseCost.output)} out`,
        ]
      : []),
  ];
  return {
    ...(parts.length > 0 ? { metaLabel: parts.join(" · ") } : {}),
    ...(isFreeZen ? { promoLabel: "Free" } : {}),
  };
}

export interface OpenCodeUsageLimitsInput {
  readonly workspace?: {
    readonly id?: string;
    readonly name?: string;
    readonly usageURL?: string;
  };
  readonly go?: {
    readonly rolling?: {
      readonly percent: number;
      readonly limited: boolean;
      readonly resetsAt: number;
    };
    readonly weekly?: {
      readonly percent: number;
      readonly limited: boolean;
      readonly resetsAt: number;
    };
    readonly monthly?: {
      readonly percent: number;
      readonly limited: boolean;
      readonly resetsAt: number;
    };
  };
  readonly budgets?: ReadonlyArray<{
    readonly id: string;
    readonly limit: number;
    readonly spent: number;
    readonly coverage: "all" | "models";
    readonly models?: ReadonlyArray<{ readonly name: string }>;
    readonly resetsAt: number;
  }>;
}

function wholeUsedPercent(percent: number, limited: boolean): number {
  if (limited || percent >= 100) return 100;
  return Math.max(0, Math.min(99, Math.round(percent)));
}

function toResetSeconds(resetsAt: number | undefined): number | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= 0) return undefined;
  return resetsAt >= 10_000_000_000 ? Math.round(resetsAt / 1000) : Math.round(resetsAt);
}

/**
 * Maps OpenCode's `/api/experimental/usage/limits` response onto Threadlines'
 * account usage contract. Uses `grok-billing` with an explicit `limitName` so
 * older clients never reject the wire enum (see `ServerProviderAccountUsage.source`).
 */
export function openCodeAccountUsage(
  limits: OpenCodeUsageLimitsInput | null | undefined,
  checkedAt: string,
): ServerProviderAccountUsage | undefined {
  if (!limits) return undefined;
  const go = limits.go;
  const toWindow = (
    meter:
      | { readonly percent: number; readonly limited: boolean; readonly resetsAt: number }
      | undefined,
    windowDurationMins: number,
  ): ServerProviderUsageWindow | undefined => {
    if (!meter || !Number.isFinite(meter.percent)) return undefined;
    const usedPercent = wholeUsedPercent(meter.percent, meter.limited);
    const resetsAt = toResetSeconds(meter.resetsAt);
    return {
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      windowDurationMins,
      checkedAt,
    };
  };

  const primary = toWindow(go?.rolling, GO_ROLLING_WINDOW_MINS);
  const secondary = toWindow(go?.weekly, GO_WEEKLY_WINDOW_MINS);
  const scoped: Array<ServerProviderScopedUsageWindow> = [];
  if (go?.monthly && Number.isFinite(go.monthly.percent)) {
    const usedPercent = wholeUsedPercent(go.monthly.percent, go.monthly.limited);
    const resetsAt = toResetSeconds(go.monthly.resetsAt);
    scoped.push({
      scopeLabel: "Monthly",
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      windowDurationMins: GO_MONTHLY_WINDOW_MINS,
      ...(go.monthly.limited ? { severity: "warning" } : {}),
      checkedAt,
    });
  }

  let individualLimit: ServerProviderSpendControlLimit | undefined;
  for (const budget of limits.budgets ?? []) {
    if (!Number.isFinite(budget.limit) || budget.limit <= 0 || !Number.isFinite(budget.spent)) {
      continue;
    }
    const spent = Math.max(0, budget.spent);
    const usedRatio = (spent / budget.limit) * 100;
    const usedPercent = wholeUsedPercent(usedRatio, spent >= budget.limit);
    const remainingPercent = Math.max(0, 100 - usedPercent);
    const resetsAt = toResetSeconds(budget.resetsAt);
    if (budget.coverage === "all") {
      if (individualLimit === undefined || remainingPercent < individualLimit.remainingPercent) {
        individualLimit = {
          limit: formatOpenCodeUsd(budget.limit),
          used: formatOpenCodeUsd(spent),
          remainingPercent,
          ...(resetsAt !== undefined ? { resetsAt } : {}),
        };
      }
      continue;
    }
    const modelNames = (budget.models ?? [])
      .map((entry) => nonEmptyTrimmed(entry.name))
      .filter((name): name is string => name !== undefined);
    const scopeLabel =
      modelNames.length === 1
        ? modelNames[0]!
        : modelNames.length > 1
          ? `${modelNames[0]} +${modelNames.length - 1}`
          : "Model budget";
    scoped.push({
      scopeLabel,
      ...(modelNames.length > 0 ? { scopeModels: modelNames } : {}),
      usedPercent,
      remainingPercent,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      windowDurationMins: GO_MONTHLY_WINDOW_MINS,
      ...(spent >= budget.limit ? { severity: "warning" } : {}),
      checkedAt,
    });
  }

  if (!primary && !secondary && !individualLimit && scoped.length === 0) {
    return undefined;
  }

  const rateLimitReachedType = go?.rolling?.limited
    ? "rolling"
    : go?.weekly?.limited
      ? "weekly"
      : go?.monthly?.limited
        ? "monthly"
        : individualLimit && individualLimit.remainingPercent === 0
          ? "budget"
          : undefined;
  const workspaceName = nonEmptyTrimmed(limits.workspace?.name);
  const limitName = go
    ? workspaceName
      ? `OpenCode Go (${workspaceName})`
      : "OpenCode Go"
    : workspaceName
      ? `OpenCode (${workspaceName})`
      : "OpenCode";

  return {
    source: "grok-billing",
    checkedAt,
    primaryLimitId: "opencode",
    limits: [
      {
        limitId: "opencode",
        limitName,
        ...(go ? { planType: "Go" } : {}),
        ...(rateLimitReachedType ? { rateLimitReachedType } : {}),
        ...(individualLimit ? { individualLimit } : {}),
        ...(primary ? { primary } : {}),
        ...(secondary ? { secondary } : {}),
        ...(scoped.length > 0 ? { scoped } : {}),
      },
    ],
  };
}

/**
 * Extracts the active limit reset for a failed turn from OpenCode's account
 * usage, including the Go monthly meter (`scoped`) and all-model Console
 * budget (`individualLimit`) in addition to the rolling/weekly windows.
 */
export function openCodeUsageLimitFromAccountUsage(
  accountUsage: ServerProviderAccountUsage | undefined,
  nowMs: number,
): RuntimeUsageLimit | undefined {
  const standard = usageLimitFromAccountUsage(accountUsage, nowMs);
  if (standard !== undefined || accountUsage === undefined) return standard;
  let latestResetMs: number | undefined;
  for (const limit of accountUsage.limits) {
    for (const scoped of limit.scoped ?? []) {
      if (scoped.scopeLabel !== "Monthly") continue;
      if (scoped.usedPercent < 100 && scoped.remainingPercent > 0) continue;
      const resetMs = usageResetTimeMs(scoped.resetsAt);
      if (resetMs !== undefined && resetMs > nowMs) {
        if (latestResetMs === undefined || resetMs > latestResetMs) {
          latestResetMs = resetMs;
        }
      }
    }
    const spend = limit.individualLimit;
    if (spend && spend.remainingPercent <= 0) {
      const resetMs = usageResetTimeMs(spend.resetsAt);
      if (resetMs !== undefined && resetMs > nowMs) {
        if (latestResetMs === undefined || resetMs > latestResetMs) {
          latestResetMs = resetMs;
        }
      }
    }
  }
  return latestResetMs !== undefined
    ? { resetsAt: new Date(latestResetMs).toISOString() }
    : undefined;
}

/** Reasoning variants, with OpenCode's usual middle ground preselected. */
export function openCodeVariantCapabilities(variants: ReadonlyArray<string>): ModelCapabilities {
  const usable = variants.filter((variant) => variant !== "default");
  if (usable.length === 0) return CUSTOM_MODEL_CAPABILITIES;
  const preferred = ["medium", "high"].find((variant) => usable.includes(variant)) ?? usable[0]!;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "variant",
        label: "Reasoning",
        type: "select",
        options: usable.map((variant) =>
          variant === preferred
            ? { id: variant, label: titleCase(variant), isDefault: true as const }
            : { id: variant, label: titleCase(variant) },
        ),
        currentValue: preferred,
      },
    ],
  });
}

interface OpenCodeCatalog {
  readonly models: ReadonlyArray<ServerProviderModel>;
  /**
   * Providers the user connected, by name: any listed model that costs money
   * or comes from a provider other than OpenCode's free Zen tier. Empty when
   * only the free models are available.
   */
  readonly connectedProviders: ReadonlyArray<string>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly accountUsage?: ServerProviderAccountUsage;
  /** True when `/api/experimental/usage/limits` failed transiently (not 404/501 or null). */
  readonly usageLimitsFailed?: boolean;
}

/** The server lists nothing for a moment while a directory loads. */
const retryWhileEmpty = <A>(load: Effect.Effect<ReadonlyArray<A>, OpenCodeError>) =>
  load.pipe(
    Effect.flatMap((items) =>
      items.length > 0 ? Effect.succeed(items) : Effect.fail("empty" as const),
    ),
    Effect.retry({
      while: (error) => error === "empty",
      schedule: Schedule.exponential(Duration.millis(100), 1.55),
      times: 8,
    }),
    Effect.catch((error) => (error === "empty" ? Effect.succeed([]) : Effect.fail(error))),
  );

export const loadOpenCodeCatalog = (
  client: OpenCodeClient,
  directory: string,
  checkedAt?: string,
): Effect.Effect<OpenCodeCatalog, OpenCodeError> =>
  Effect.gen(function* () {
    const location = { location: { directory } };
    const [models, defaultModel, providers, commands, skills, usageLimits] = yield* Effect.all(
      [
        retryWhileEmpty(
          runOpenCode("model.list", (signal) => client.model.list(location, { signal })).pipe(
            Effect.map((result) => result.data ?? []),
          ),
        ),
        typeof client.model.default === "function"
          ? runOpenCode("model.default", (signal) =>
              client.model.default(location, { signal }),
            ).pipe(
              Effect.map((result) => result.data ?? null),
              Effect.orElseSucceed(() => null),
            )
          : Effect.succeed(null),
        runOpenCode("provider.list", (signal) => client.provider.list(location, { signal })).pipe(
          Effect.map((result) => result.data ?? []),
          Effect.orElseSucceed(() => []),
        ),
        runOpenCode("command.list", (signal) => client.command.list(location, { signal })).pipe(
          Effect.map((result) => result.data ?? []),
          Effect.orElseSucceed(() => []),
        ),
        runOpenCode("skill.list", (signal) => client.skill.list(location, { signal })).pipe(
          Effect.map((result) => result.data ?? []),
          Effect.orElseSucceed(() => []),
        ),
        typeof client.experimental?.usage?.limits === "function"
          ? runOpenCode("usage.limits", (signal) =>
              client.experimental.usage.limits(location, { signal }),
            ).pipe(
              Effect.map((result) => ({
                failed: false as const,
                data: result.data ?? null,
              })),
              Effect.catch((error) => {
                const status = openCodeErrorStatus(error);
                const unsupported = status === 404 || status === 405 || status === 501;
                return Effect.succeed({
                  failed: !unsupported,
                  data: null,
                });
              }),
            )
          : Effect.succeed({ failed: false as const, data: null }),
      ],
      { concurrency: "unbounded" },
    );
    const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
    const activeModels = models.filter(
      (model) => model.enabled !== false && model.status !== "deprecated",
    );
    const defaultSlug =
      defaultModel && defaultModel.providerID && defaultModel.id
        ? `${defaultModel.providerID}/${defaultModel.id}`
        : undefined;
    const usageTimestamp = checkedAt ?? DateTime.formatIso(yield* DateTime.now);
    const accountUsage = openCodeAccountUsage(usageLimits.data, usageTimestamp);
    return {
      models: activeModels
        .flatMap((model): ReadonlyArray<ServerProviderModel> => {
          const slug = `${model.providerID}/${model.id}`;
          const name = nonEmptyTrimmed(model.name) ?? model.id;
          const subProvider = nonEmptyTrimmed(providerNames.get(model.providerID));
          const meta = openCodeModelMeta(model);
          return [
            {
              slug,
              name,
              ...(subProvider ? { subProvider } : {}),
              isCustom: false,
              ...(defaultSlug === slug ? { isDefault: true } : {}),
              ...meta,
              capabilities: openCodeVariantCapabilities(
                (model.variants ?? []).map((variant) => variant.id),
              ),
            },
          ];
        })
        .toSorted((left, right) => left.name.localeCompare(right.name)),
      connectedProviders: [
        ...new Set(
          activeModels
            .filter(
              (model) =>
                model.providerID !== OPENCODE_ZEN_PROVIDER ||
                (model.cost ?? []).some((tier) => tier.input > 0 || tier.output > 0),
            )
            .map((model) => providerNames.get(model.providerID) ?? model.providerID),
        ),
      ].toSorted((left, right) => left.localeCompare(right)),
      slashCommands: commands.flatMap((command) => {
        const name = nonEmptyTrimmed(command.name);
        if (!name) return [];
        const description = nonEmptyTrimmed(command.description);
        return [{ name, ...(description ? { description } : {}) }];
      }),
      skills: skills.flatMap((skill) => {
        const name = nonEmptyTrimmed(skill.id);
        const path = nonEmptyTrimmed(skill.path);
        if (!name || !path) return [];
        const description = nonEmptyTrimmed(skill.description);
        const displayName = nonEmptyTrimmed(skill.name);
        return [
          {
            name,
            path,
            enabled: true,
            ...(displayName && displayName !== name ? { displayName } : {}),
            ...(description ? { description } : {}),
          },
        ];
      }),
      ...(accountUsage ? { accountUsage } : {}),
      ...(usageLimits.failed ? { usageLimitsFailed: true } : {}),
    };
  });

const snapshot = (input: {
  readonly settings: OpenCodeSettings;
  readonly checkedAt: string;
  readonly probe: ProviderProbeResult;
  readonly catalog?: OpenCodeCatalog;
  readonly detection?: ServerProviderDetection;
}): ServerProviderDraft =>
  buildServerProvider({
    presentation: OPENCODE_PRESENTATION,
    enabled: input.settings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.catalog?.models ?? [],
      PROVIDER,
      input.settings.customModels,
      CUSTOM_MODEL_CAPABILITIES,
    ),
    ...(input.catalog ? { modelCatalogSource: "live" as const } : {}),
    ...(input.catalog?.slashCommands.length ? { slashCommands: input.catalog.slashCommands } : {}),
    ...(input.catalog?.skills.length ? { skills: input.catalog.skills } : {}),
    probe: input.probe,
    ...(input.detection ? { detection: input.detection } : {}),
  });

function openCodeProviderLabel(providers: ReadonlyArray<string>): string {
  return providers.length <= 3
    ? providers.join(", ")
    : `${providers.slice(0, 3).join(", ")} and ${providers.length - 3} more`;
}

/**
 * A filesystem-only look for a turned-off instance. With a server URL the
 * binary is never used, and checking the server would mean connecting to it.
 */
function detectOpenCode(
  settings: OpenCodeSettings,
  environment: NodeJS.ProcessEnv,
): ServerProviderDetection {
  const serverUrl = settings.serverUrl.trim();
  return serverUrl
    ? undetectableProvider(`Uses the OpenCode server at ${serverUrl}. Turn it on to check.`)
    : detectOpenCodeBinary(settings.binaryPath, environment);
}

export const makePendingOpenCodeProvider = (
  settings: OpenCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    snapshot({
      settings,
      checkedAt: DateTime.formatIso(now),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        // Not checked yet, so `installed` says nothing; surfaces read this
        // as "checking" rather than "missing".
        ...(settings.enabled ? { statusReason: "provider_probe_pending" as const } : {}),
        auth: { status: "unknown" },
        message: settings.enabled
          ? "OpenCode has not been checked yet."
          : "OpenCode is turned off in Threadlines settings.",
      },
      ...(settings.enabled ? {} : { detection: detectOpenCode(settings, environment) }),
    }),
  );

export const checkOpenCodeProviderStatus = (input: {
  readonly settings: OpenCodeSettings;
  readonly manager: OpenCodeServerManagerShape;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  /** A 1.x binary here has an Update that moves it to OpenCode 2. */
  readonly canMoveToOpenCodeTwo: boolean;
  /** Notified when `/api/experimental/usage/limits` failed transiently on this check. */
  readonly onUsageLimitsFailed?: () => void;
}): Effect.Effect<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const { settings } = input;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const failed = (
      probe: Omit<ProviderProbeResult, "auth" | "status"> & { readonly message: string },
    ) =>
      snapshot({
        settings,
        checkedAt,
        probe: { ...probe, status: "error", auth: { status: "unknown" } },
      });

    if (!settings.enabled) {
      return yield* makePendingOpenCodeProvider(settings, input.environment);
    }

    const external = settings.serverUrl.trim().length > 0;
    let version: string | null = null;
    if (!external) {
      const probed = yield* probeOpenCodeVersion({
        binaryPath: settings.binaryPath,
        environment: input.environment,
      }).pipe(Effect.result);
      if (probed._tag === "Failure") {
        return failed({
          installed: !isOpenCodeNotInstalledError(probed.failure),
          version: null,
          message: isOpenCodeNotInstalledError(probed.failure)
            ? "OpenCode is not installed. Install OpenCode 2 to use it in Threadlines."
            : probed.failure.detail,
        });
      }
      // The exit code decides before any version is trusted: a crash's stack
      // trace can end in a line that reads like one (`Node.js v22.23.4`).
      const startFailure = cliStartFailureFrom(probed.success.result);
      version = startFailure ? null : (probed.success.version ?? null);
      if (!version) {
        return failed({
          installed: true,
          version: null,
          ...(startFailure ? { runnable: false as const } : {}),
          message: startFailure
            ? withStartFailureReason("OpenCode is installed but cannot start.", startFailure)
            : `Could not read OpenCode's version from \`${settings.binaryPath} --version\`.`,
        });
      }
      if (!isSupportedOpenCodeVersion(version)) {
        return failed({
          installed: true,
          version,
          // OpenCode 2 is a separate package. The driver turns Update into
          // the move for install methods it knows; others install by hand.
          message: !isOpenCodeOneVersion(version)
            ? `OpenCode ${version} is too old. Update to ${MINIMUM_OPENCODE_VERSION} or newer.`
            : input.canMoveToOpenCodeTwo
              ? `Threadlines needs OpenCode 2, and \`${settings.binaryPath}\` is OpenCode ${version}. Update moves it to OpenCode 2 and keeps your OpenCode chats.`
              : `Threadlines needs OpenCode 2, and \`${settings.binaryPath}\` is OpenCode ${version}. Install OpenCode 2 with \`${process.platform === "win32" ? "npm install -g @opencode/cli" : OPENCODE_INSTALL_COMMAND}\`. If Threadlines still finds 1.x afterwards, set Binary path to the new one.`,
        });
      }
    }

    const installedVersion = version;
    const catalog = yield* input.manager
      .withServer((active) =>
        Effect.gen(function* () {
          version = version ?? active.server.version;
          // The binary was updated under a running server: restart it once
          // nothing is using it, so new sessions get the new version.
          if (installedVersion && installedVersion !== active.server.version) {
            yield* input.manager.retire;
          }
          return yield* loadOpenCodeCatalog(active.server.client, input.cwd, checkedAt);
        }),
      )
      .pipe(Effect.result);
    if (catalog._tag === "Failure") {
      return failed({ installed: true, version, message: catalog.failure.detail });
    }
    const { connectedProviders, models, accountUsage, usageLimitsFailed } = catalog.success;
    if (usageLimitsFailed) {
      input.onUsageLimitsFailed?.();
    }
    const connected = connectedProviders.length > 0;
    return snapshot({
      settings,
      checkedAt,
      catalog: catalog.success,
      probe: {
        installed: true,
        version,
        status: models.length > 0 ? "ready" : "warning",
        // OpenCode's free models need no account, so a catalog of only those
        // is signed in, labelled for what it is; "Sign in again" adds a
        // provider. No models at all is the one state that needs a sign-in.
        auth:
          models.length === 0
            ? { status: "unauthenticated" }
            : {
                status: "authenticated",
                type: "opencode",
                label: connected ? openCodeProviderLabel(connectedProviders) : "Free models only",
              },
        ...(accountUsage ? { accountUsage } : {}),
        message:
          models.length === 0
            ? "OpenCode has no models it can use yet. Sign in to connect a provider."
            : connected
              ? `${models.length} model${models.length === 1 ? "" : "s"} available through ${external ? "the configured OpenCode server" : "OpenCode"}.`
              : "Only OpenCode's free models are available. Sign in again to connect your own provider.",
      },
    });
  });
