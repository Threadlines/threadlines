/**
 * PiProvider — the Pi provider snapshot: which Pi runs, its version, the
 * models it can use with their thinking levels, and its slash commands and
 * skills (docs/providers/pi-plan.md, "Models and reasoning", "Sign-in and
 * readiness").
 *
 * The check starts a short-lived `pi --mode rpc --no-session` with the user's
 * extensions loaded, so providers that extensions add count, and asks
 * `get_state`, `get_available_models` and `get_commands`. Pi lists only models
 * it has credentials for, so ready means at least one model; none means Pi
 * needs signing in (Threadlines asks Pi's `/login` questions) or a key.
 *
 * @module provider/Layers/PiProvider
 */
import {
  DEFAULT_PI_MODEL,
  type ModelCapabilities,
  ProviderDriverKind,
  type PiSettings,
  type ProviderInstanceEnvironment,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@threadlines/contracts";
import { createModelCapabilities } from "@threadlines/shared/model";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ChildProcessSpawner } from "effect/process";

import { detectPiBinary } from "../pi/PiBinary.ts";
import type { PiInstallation } from "../pi/PiInstallation.ts";
import {
  PI_ACCESS_LEVELS,
  type PiLaunch,
  piProcessArgs,
  piProcessEnvironment,
} from "../pi/PiLaunch.ts";
import {
  decodePi,
  type PiCommandInfo,
  PiAvailableModels,
  PiCommands,
  type PiModel,
  piModelSlug,
  piProviderName,
  PiState,
} from "../pi/PiProtocol.ts";
import { startPiRpc } from "../pi/PiRpc.ts";
import {
  buildServerProvider,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { visiblePiCommands } from "./PiAdapter.ts";

const PI_DRIVER_KIND = ProviderDriverKind.make("pi");

export const PI_PRESENTATION = {
  displayName: "Pi",
  // Plan mode is enforced by the Threadlines extension.
  showInteractionModeToggle: true,
  supportedRuntimeModes: PI_ACCESS_LEVELS,
} as const;

const DISCOVERY_STARTUP_TIMEOUT = Duration.seconds(15);

/** Pi's thinking levels, lowest first (pi-ai's `EXTENDED_THINKING_LEVELS`). */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const LEVEL_LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/** The levels a model supports, as Pi decides them (pi-ai's `getSupportedThinkingLevels`). */
export function piThinkingLevels(
  model: Pick<PiModel, "reasoning" | "thinkingLevelMap">,
): ReadonlyArray<string> {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}

/** The level Pi would use for `level` on a model with `levels` (pi-ai's `clampThinkingLevel`). */
export function clampPiThinkingLevel(levels: ReadonlyArray<string>, level: string): string {
  if (levels.includes(level)) return level;
  const requested = THINKING_LEVELS.indexOf(level as (typeof THINKING_LEVELS)[number]);
  if (requested < 0) return levels[0] ?? "off";
  const higher = THINKING_LEVELS.slice(requested).find((candidate) => levels.includes(candidate));
  const lower = THINKING_LEVELS.slice(0, requested)
    .toReversed()
    .find((candidate) => levels.includes(candidate));
  return higher ?? lower ?? levels[0] ?? "off";
}

/** The thinking picker for one model; none for a model that can't think. */
export function piModelCapabilities(
  levels: ReadonlyArray<string>,
  /** Pi's current level, which a model takes clamped. */
  currentLevel: string | undefined,
): ModelCapabilities {
  if (levels.length <= 1) return createModelCapabilities({ optionDescriptors: [] });
  const current = clampPiThinkingLevel(levels, currentLevel ?? "medium");
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Thinking",
        type: "select",
        currentValue: current,
        options: levels.map((level) => ({
          id: level,
          label: LEVEL_LABELS[level] ?? level,
          ...(level === current ? { isDefault: true as const } : {}),
        })),
      },
    ],
  });
}

const contextLabel = (tokens: number | undefined) =>
  tokens === undefined || tokens <= 0
    ? undefined
    : tokens >= 1_000_000
      ? `${Number((tokens / 1_000_000).toFixed(1))}M ctx`
      : `${Math.round(tokens / 1000)}K ctx`;

/**
 * The picker's models: "Pi default" first (whatever the user set in Pi),
 * then every model Pi can use, grouped by Pi's provider.
 */
export function piCatalogModels(input: {
  readonly models: ReadonlyArray<PiModel>;
  /** Pi's current model and level, from `get_state`. */
  readonly current: PiModel | null | undefined;
  readonly thinkingLevel: string | undefined;
}): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const listed = input.models.flatMap((model): ReadonlyArray<ServerProviderModel> => {
    const slug = piModelSlug(model);
    if (seen.has(slug)) return [];
    seen.add(slug);
    const meta = contextLabel(model.contextWindow);
    return [
      {
        slug,
        name: model.name?.trim() || model.id,
        subProvider: piProviderName(model.provider),
        isCustom: false,
        ...(meta ? { metaLabel: meta } : {}),
        capabilities: piModelCapabilities(piThinkingLevels(model), input.thinkingLevel),
      },
    ];
  });
  if (listed.length === 0) return [];
  const current = input.current;
  return [
    {
      slug: DEFAULT_PI_MODEL,
      name: "Pi default",
      ...(current
        ? { description: `The model set in Pi: ${current.name?.trim() || current.id}` }
        : {}),
      isCustom: false,
      isDefault: true,
      capabilities: current
        ? piModelCapabilities(piThinkingLevels(current), input.thinkingLevel)
        : createModelCapabilities({ optionDescriptors: [] }),
    },
    ...listed,
  ];
}

/**
 * Pi's commands for the composer: skills (with their file, so a chosen skill
 * is read from it) and the rest as slash commands. Pi's own terminal-app
 * commands and Threadlines' internal ones are left out.
 */
export function piComposerCommands(commands: ReadonlyArray<PiCommandInfo>): {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
} {
  const slashCommands: Array<ServerProviderSlashCommand> = [];
  const skills: Array<ServerProviderSkill> = [];
  for (const command of visiblePiCommands(commands)) {
    const description = command.description?.trim() || undefined;
    if (command.source === "skill") {
      const path = command.sourceInfo?.path?.trim();
      const name = command.name.replace(/^skill:/u, "").trim();
      if (!path || !name) continue;
      const scope = command.sourceInfo?.scope?.trim();
      skills.push({
        name,
        path,
        enabled: true,
        ...(description ? { description } : {}),
        ...(scope ? { scope } : {}),
      });
      continue;
    }
    if (!command.name.trim()) continue;
    slashCommands.push({ name: command.name, ...(description ? { description } : {}) });
  }
  return { slashCommands, skills };
}

const snapshot = (input: {
  readonly settings: PiSettings;
  readonly checkedAt: string;
  readonly probe: ProviderProbeResult;
  readonly models?: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills?: ReadonlyArray<ServerProviderSkill>;
  readonly environment?: NodeJS.ProcessEnv;
}): ServerProviderDraft => {
  const live = input.models !== undefined && input.models.length > 0;
  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: input.settings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      live ? input.models! : [],
      PI_DRIVER_KIND,
      input.settings.customModels,
      createModelCapabilities({ optionDescriptors: [] }),
    ),
    modelCatalogSource: live ? "live" : "fallback",
    ...(input.slashCommands ? { slashCommands: input.slashCommands } : {}),
    ...(input.skills ? { skills: input.skills } : {}),
    probe: input.probe,
    ...(!input.settings.enabled && input.environment
      ? { detection: detectPiBinary(input.settings.binaryPath, input.environment) }
      : {}),
  });
};

export const makePendingPiProvider = (
  settings: PiSettings,
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
          ? "Pi has not been checked yet."
          : "Pi is turned off in Threadlines settings.",
      },
    }),
  );

/** What a check learned that the adapter needs. */
export interface PiProbeFacts {
  /** For thinking-level checks. */
  readonly models: ReadonlyArray<ServerProviderModel>;
  /** The model Pi's own settings name, which "Pi default" means. */
  readonly defaultModel: { readonly provider: string; readonly modelId: string } | undefined;
}

const SIGN_IN_MESSAGE =
  "Pi has no models it can use yet. Sign in to connect a provider, or add a provider key.";

export const checkPiProviderStatus = (input: {
  readonly settings: PiSettings;
  readonly installation: PiInstallation;
  readonly launch: PiLaunch;
  readonly launchArgs: ReadonlyArray<string>;
  readonly cwd: string;
  readonly instanceEnvironment: ProviderInstanceEnvironment | undefined;
  /** The server's environment; tests pass their own. */
  readonly baseEnvironment?: NodeJS.ProcessEnv | undefined;
  readonly onFacts?: (facts: PiProbeFacts) => Effect.Effect<void>;
}): Effect.Effect<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const { settings, installation } = input;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (installation.kind === "missing" || installation.kind === "unusable") {
      return snapshot({
        settings,
        checkedAt,
        probe: {
          installed: installation.kind === "unusable",
          version: installation.kind === "unusable" ? installation.version : null,
          status: "error",
          auth: { status: "unknown" },
          message: installation.message,
        },
      });
    }
    const version = installation.version;

    const facts = yield* Effect.scoped(
      Effect.gen(function* () {
        const launcher = yield* input.launch;
        const rpc = yield* startPiRpc({
          command: launcher.command,
          args: piProcessArgs(launcher, { purpose: "discovery", launchArgs: input.launchArgs }),
          cwd: input.cwd,
          environment: piProcessEnvironment({
            instanceEnvironment: input.instanceEnvironment,
            ...(input.baseEnvironment ? { baseEnv: input.baseEnvironment } : {}),
          }),
          startupTimeout: DISCOVERY_STARTUP_TIMEOUT,
        });
        const state = decodePi(PiState)(yield* rpc.request({ type: "get_state" }));
        const models = decodePi(PiAvailableModels)(
          yield* rpc.request({ type: "get_available_models" }),
        );
        const commands = decodePi(PiCommands)(
          yield* rpc.request({ type: "get_commands" }).pipe(Effect.orElseSucceed(() => undefined)),
        );
        return {
          state: Option.getOrUndefined(state),
          models: Option.match(models, { onNone: () => [], onSome: (value) => value.models }),
          commands: Option.match(commands, { onNone: () => [], onSome: (value) => value.commands }),
        };
      }),
    ).pipe(Effect.result);
    if (facts._tag === "Failure") {
      return snapshot({
        settings,
        checkedAt,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: facts.failure.message,
        },
      });
    }

    const catalog = piCatalogModels({
      models: facts.success.models,
      current: facts.success.state?.model,
      thinkingLevel: facts.success.state?.thinkingLevel,
    });
    const configured = facts.success.state?.model;
    if (input.onFacts) {
      yield* input.onFacts({
        models: catalog,
        defaultModel: configured
          ? { provider: configured.provider, modelId: configured.id }
          : undefined,
      });
    }
    const providers = [...new Set(facts.success.models.map((model) => model.provider))].map(
      piProviderName,
    );
    const { slashCommands, skills } = piComposerCommands(facts.success.commands);
    const ready = catalog.length > 0;
    return snapshot({
      settings,
      checkedAt,
      models: catalog,
      slashCommands,
      skills,
      probe: {
        installed: true,
        version,
        status: ready ? "ready" : "warning",
        auth: ready
          ? {
              status: "authenticated",
              type: "piProviders",
              label:
                providers.length > 3
                  ? `${providers.slice(0, 3).join(", ")} and ${providers.length - 3} more`
                  : providers.join(", "),
            }
          : { status: "unauthenticated" },
        message: ready
          ? `${catalog.length - 1} model${catalog.length === 2 ? "" : "s"} available.`
          : SIGN_IN_MESSAGE,
      },
    });
  });
