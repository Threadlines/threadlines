/**
 * MuseProvider — the Muse Code provider snapshot: install, version, sign-in,
 * models with their reasoning tiers, and the plan's usage.
 *
 * The check runs `muse --version`, then a short-lived host that can do
 * nothing (`--no-session-log --disable-shell --disable-write`) for
 * `model/list`, `account/read` and `usage/read`. Signed out, Muse lists no
 * models, so the picker falls back to Threadlines' default Muse model.
 *
 * `account/read` is part of Muse's experimental protocol surface: a host that
 * refuses it leaves sign-in "unknown", and a turn's `authRequired` error
 * still says to sign in.
 *
 * @module provider/Layers/MuseProvider
 */
import {
  DEFAULT_MUSE_MODEL,
  type ModelCapabilities,
  type MuseSettings,
  ProviderDriverKind,
  type ProviderInstanceEnvironment,
  type ServerProviderAccountUsage,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@threadlines/contracts";
import { createModelCapabilities } from "@threadlines/shared/model";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import { hideWindowsConsole } from "@threadlines/shared/childProcess";

import { planCliSpawn } from "../../cliSpawn.ts";
import {
  detectMuseBinary,
  isSupportedMuseVersion,
  MINIMUM_MUSE_VERSION,
  parseMuseVersion,
} from "../muse/MuseBinary.ts";
import { startMuseHost } from "../muse/MuseHost.ts";
import { museBillingRefusal, museHostProfile } from "../muse/MuseLaunch.ts";
import {
  MuseAccountState,
  type MuseModelCatalogEntry,
  MuseModelList,
  MuseSubscriptionUsage,
} from "../muse/MuseProtocol.ts";
import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
  spawnAndCollect,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("muse");

export const MUSE_PRESENTATION = {
  displayName: "Muse Code",
  // Plan mode runs on a read-only host.
  showInteractionModeToggle: true,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
} as const;

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};
/** Muse's own CLI default, and its tiers when a model reports none. */
const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const FALLBACK_DEFAULT_EFFORT = "high";

/** The reasoning picker for one catalog row (or the fallback without one). */
export function museModelCapabilities(
  model?: Pick<
    MuseModelCatalogEntry,
    "variants" | "defaultReasoningEffort" | "reasoningEffortVariants"
  >,
): ModelCapabilities {
  const reported = Array.isArray(model?.variants) ? model.variants : undefined;
  // Meta's provider rejects `none`.
  const efforts = (reported ?? FALLBACK_EFFORTS).filter((tier) => tier in EFFORT_LABELS);
  const preferred = reported ? model?.defaultReasoningEffort : FALLBACK_DEFAULT_EFFORT;
  const current = efforts.find((tier) => tier === preferred) ?? efforts[0];
  if (!current) return createModelCapabilities({ optionDescriptors: [] });
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: current,
        options: efforts.map((tier) => {
          const description = model?.reasoningEffortVariants?.find(
            (variant) => variant.tier === tier,
          )?.description;
          return {
            id: tier,
            label: EFFORT_LABELS[tier] ?? tier,
            ...(tier === current ? { isDefault: true as const } : {}),
            ...(description ? { description } : {}),
          };
        }),
      },
    ],
  });
}

const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEFAULT_MUSE_MODEL,
    name: "Muse Spark 1.3",
    isCustom: false,
    isDefault: true,
    capabilities: museModelCapabilities(),
  },
];

/**
 * A model's name for the picker. Muse 1.4.9 sends the id as `displayLabel`,
 * so an id-shaped label reads as words: `muse-spark-1.3` is "Muse Spark 1.3".
 */
export function museModelName(entry: Pick<MuseModelCatalogEntry, "modelId" | "displayLabel">) {
  const label = entry.displayLabel?.trim();
  if (label && label !== entry.modelId) return label;
  return entry.modelId
    .split("-")
    .filter((word) => word.length > 0)
    .map((word) => (/^[a-z]/u.test(word) ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

export function museCatalogModels(
  entries: ReadonlyArray<MuseModelCatalogEntry>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return entries.flatMap((entry): ReadonlyArray<ServerProviderModel> => {
    if (seen.has(entry.modelId)) return [];
    seen.add(entry.modelId);
    return [
      {
        slug: entry.modelId,
        name: museModelName(entry),
        ...(entry.description?.trim() ? { description: entry.description.trim() } : {}),
        isCustom: false,
        ...(entry.isDefault ? { isDefault: true } : {}),
        capabilities: museModelCapabilities(entry),
      },
    ];
  });
}

/** The plan's 5-hour window and weekly block as Threadlines usage limits. */
export function museAccountUsage(
  usage: typeof MuseSubscriptionUsage.Type,
  checkedAt: string,
): ServerProviderAccountUsage | undefined {
  const window = usage.window;
  const weekly = usage.weekly;
  if (!window && !weekly) return undefined;
  const toWindow = (input: {
    readonly usedPercent: number;
    readonly resetsAtMs?: number | undefined;
    readonly windowDurationMins?: number | undefined;
  }) => {
    const used = Math.max(0, Math.round(input.usedPercent));
    return {
      usedPercent: used,
      remainingPercent: Math.max(0, 100 - used),
      ...(input.resetsAtMs ? { resetsAt: Math.round(input.resetsAtMs / 1000) } : {}),
      ...(input.windowDurationMins
        ? { windowDurationMins: Math.round(input.windowDurationMins) }
        : {}),
      checkedAt,
    };
  };
  return {
    source: "muse-subscription-usage",
    checkedAt,
    primaryLimitId: "muse",
    limits: [
      {
        limitId: "muse",
        limitName: "Muse Code",
        // Muse 1.4.9 sends an internal number as the tier, not a plan name.
        ...(usage.tier && !/^\d+$/u.test(usage.tier) ? { planType: usage.tier } : {}),
        ...(window ? { primary: toWindow(window) } : {}),
        ...(weekly ? { secondary: toWindow({ ...weekly, windowDurationMins: 7 * 24 * 60 }) } : {}),
      },
    ],
  };
}

/**
 * What Settings shows for Muse's sign-in. Muse names a Meta account by its
 * email: that goes in `email`, which Settings hides until clicked as it does
 * every agent's, and the label says what kind of account it is.
 */
export function museAuth(account: typeof MuseAccountState.Type | undefined): ServerProviderAuth {
  switch (account?.state) {
    case "accountLogin": {
      const name = account.label?.trim();
      return name && /^[^\s@]+@[^\s@]+$/u.test(name)
        ? { status: "authenticated", type: "metaAccount", label: "Meta account", email: name }
        : { status: "authenticated", type: "metaAccount", label: name || "Meta account" };
    }
    case "apiKey":
    case "envKey":
      return { status: "authenticated", type: "apiKey", label: "API key, billed per use" };
    case "loggedOut":
      return account.credentialRequired === false
        ? { status: "authenticated", type: "metaAccount", label: "No sign-in needed" }
        : { status: "unauthenticated" };
    default:
      return { status: "unknown" };
  }
}

const snapshot = (input: {
  readonly settings: MuseSettings;
  readonly checkedAt: string;
  readonly probe: ProviderProbeResult;
  readonly models?: ReadonlyArray<ServerProviderModel>;
  readonly environment?: NodeJS.ProcessEnv;
}): ServerProviderDraft => {
  const live = input.models !== undefined && input.models.length > 0;
  return buildServerProvider({
    presentation: MUSE_PRESENTATION,
    enabled: input.settings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      live ? input.models! : FALLBACK_MODELS,
      PROVIDER,
      input.settings.customModels,
      museModelCapabilities(),
    ),
    modelCatalogSource: live ? "live" : "fallback",
    probe: input.probe,
    ...(!input.settings.enabled && input.environment
      ? { detection: detectMuseBinary(input.settings.binaryPath, input.environment) }
      : {}),
  });
};

export const makePendingMuseProvider = (
  settings: MuseSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    snapshot({
      settings,
      checkedAt: DateTime.formatIso(now),
      environment,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        ...(settings.enabled ? { statusReason: "provider_probe_pending" as const } : {}),
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Muse Code has not been checked yet."
          : "Muse Code is turned off in Threadlines settings.",
      },
    }),
  );

export interface MuseProbeFacts {
  /** The host reported it can enforce the shell sandbox. */
  readonly sandboxAvailable: boolean | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

const decodeModelList = Schema.decodeUnknownOption(MuseModelList);
const decodeAccount = Schema.decodeUnknownOption(MuseAccountState);
const decodeUsage = Schema.decodeUnknownOption(
  Schema.Struct({ usage: Schema.optional(MuseSubscriptionUsage) }),
);

export const checkMuseProviderStatus = (input: {
  readonly settings: MuseSettings;
  /** The resolved binary. */
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  /** The instance's own variables, for the per-use gate. */
  readonly instanceEnvironment?: ProviderInstanceEnvironment | undefined;
  /** Facts a live host reported, for the adapter. */
  readonly onFacts?: (facts: MuseProbeFacts) => Effect.Effect<void>;
}): Effect.Effect<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const { settings } = input;
    if (!settings.enabled) return yield* makePendingMuseProvider(settings, input.environment);
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const failed = (
      probe: Omit<ProviderProbeResult, "auth" | "status"> & { readonly message: string },
    ) =>
      snapshot({
        settings,
        checkedAt,
        probe: { ...probe, status: "error", auth: { status: "unknown" } },
      });

    const plan = planCliSpawn(input.binaryPath, ["--version"], input.environment);
    const versionResult = yield* spawnAndCollect(
      input.binaryPath,
      ChildProcess.make(
        plan.command,
        [...plan.args],
        hideWindowsConsole({ env: input.environment, cwd: input.cwd, ...plan.options }),
      ),
    ).pipe(Effect.timeoutOption(Duration.millis(DEFAULT_TIMEOUT_MS * 3)), Effect.result);
    if (versionResult._tag === "Failure") {
      const missing = isCommandMissingCause(versionResult.failure);
      return failed({
        installed: !missing,
        version: null,
        message: missing
          ? "Muse Code is not installed. Install it to use it in Threadlines."
          : `Could not run ${input.binaryPath}: ${versionResult.failure.message}`,
      });
    }
    if (Option.isNone(versionResult.success)) {
      return failed({
        installed: true,
        version: null,
        message: "Muse Code did not answer `muse --version` in time.",
      });
    }
    const output = versionResult.success.value;
    const version = parseMuseVersion(`${output.stdout}\n${output.stderr}`);
    if (output.code !== 0 || !version) {
      return failed({
        installed: true,
        version,
        message: `Could not read Muse Code's version from \`${input.binaryPath} --version\`.`,
      });
    }
    if (!isSupportedMuseVersion(version)) {
      return failed({
        installed: true,
        version,
        message: `Muse Code ${version} is too old. Update to ${MINIMUM_MUSE_VERSION} or newer.`,
      });
    }

    const profile = museHostProfile({
      purpose: "utility",
      runtimeMode: "approval-required",
      contributorMode: undefined,
      sandboxAvailable: undefined,
    });
    const facts = yield* Effect.scoped(
      Effect.gen(function* () {
        const host = yield* startMuseHost({
          binaryPath: input.binaryPath,
          args: profile.args,
          environment: input.environment,
          cwd: input.cwd,
          experimentalApi: true,
          startupTimeout: Duration.seconds(12),
        });
        const models = yield* host.request("model/list", {}).pipe(
          Effect.map((raw) => Option.getOrUndefined(decodeModelList(raw))),
          Effect.orElseSucceed(() => undefined),
        );
        const account = host.initialize.experimentalApi
          ? yield* host.request("account/read", {}).pipe(
              Effect.map((raw) => Option.getOrUndefined(decodeAccount(raw))),
              Effect.orElseSucceed(() => undefined),
            )
          : undefined;
        const usage = yield* host.request("usage/read", {}).pipe(
          Effect.map((raw) => Option.getOrUndefined(decodeUsage(raw))?.usage),
          Effect.orElseSucceed(() => undefined),
        );
        return {
          sandboxAvailable:
            host.initialize.sandboxAvailability === undefined
              ? undefined
              : host.initialize.sandboxAvailability === "available",
          models,
          account,
          usage,
        };
      }),
    ).pipe(Effect.result);
    if (facts._tag === "Failure") {
      return failed({ installed: true, version, message: facts.failure.detail });
    }
    const catalog = museCatalogModels(facts.success.models?.models ?? []);
    if (input.onFacts) {
      yield* input.onFacts({ sandboxAvailable: facts.success.sandboxAvailable, models: catalog });
    }
    const auth = museAuth(facts.success.account);
    const accountUsage = facts.success.usage
      ? museAccountUsage(facts.success.usage, checkedAt)
      : undefined;
    // The same gate chats use: a sign-in it cannot read stops Muse too.
    const refusal = museBillingRefusal({
      allowApiKeyBilling: settings.allowApiKeyBilling,
      accountState: facts.success.account?.state,
      instanceEnvironment: input.instanceEnvironment,
    });
    return snapshot({
      settings,
      checkedAt,
      models: catalog,
      probe: {
        installed: true,
        version,
        // A refused credential is a problem to fix: Muse won't run on it.
        status: refusal
          ? "error"
          : auth.status === "unauthenticated"
            ? "warning"
            : catalog.length > 0 || auth.status === "authenticated"
              ? "ready"
              : "warning",
        auth,
        ...(accountUsage ? { accountUsage } : {}),
        message:
          refusal === "apiKey"
            ? 'API key billing is off: turn on "Allow API key billing" on the Account tab, or sign in with your Meta account to use your plan.'
            : refusal === "unknown"
              ? "Threadlines couldn't tell how Muse Code is signed in, so it won't start Muse: an API key would bill per use. Sign in again, or turn on \"Allow API key billing\" on the Account tab."
              : auth.status === "unauthenticated"
                ? "Muse Code is not signed in. Sign in with your Meta account."
                : auth.type === "apiKey"
                  ? "Muse Code runs on an API key, billed per use."
                  : catalog.length === 0
                    ? "Muse Code listed no models yet. If chats fail, sign in again."
                    : `${catalog.length} model${catalog.length === 1 ? "" : "s"} available.`,
      },
    });
  });
