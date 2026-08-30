/**
 * AcpProvider — `ServerProvider` snapshots for a descriptor-driven ACP agent.
 *
 * The status check is two-phase: the descriptor's CLI probe (installed,
 * version, auth) and then, when that looks usable, a short-lived ACP session
 * whose `configOptions` supply the live model catalog. Per-model capability
 * probing runs later in the background for agents whose option set depends
 * on the selected model.
 *
 * @module provider/acp/AcpProvider
 */
import type {
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import type {
  AcpProviderDescriptor,
  AcpProviderProbeOutcome,
  AcpProviderSettings,
} from "./AcpProviderDescriptor.ts";
import {
  buildAcpDiscoveredModels,
  buildAcpModelsFromConfigOptions,
  EMPTY_ACP_MODEL_CAPABILITIES,
  flattenSessionConfigSelectOptions,
  GENERIC_ACP_MODEL_OPTION_MAPPING,
  hasAcpModelCapabilities,
  selectConfigOptionCurrentValue,
} from "./AcpProviderModels.ts";
import { makeAcpProviderRuntime } from "./AcpProviderRuntime.ts";
import { findModelConfigOption } from "./AcpRuntimeModel.ts";
import type { AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";

const ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const ACP_MODEL_CAPABILITY_TIMEOUT = "4 seconds";
const ACP_MODEL_DISCOVERY_CONCURRENCY = 4;

type ProbeEnv = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path;

function mappingFor<Settings extends AcpProviderSettings>(
  descriptor: AcpProviderDescriptor<Settings>,
) {
  return descriptor.modelOptions ?? GENERIC_ACP_MODEL_OPTION_MAPPING;
}

export function getAcpFallbackModels<Settings extends AcpProviderSettings>(
  descriptor: AcpProviderDescriptor<Settings>,
  settings: Pick<Settings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [],
    descriptor.driverKind,
    settings.customModels,
    EMPTY_ACP_MODEL_CAPABILITIES,
  );
}

export function buildInitialAcpProviderSnapshot<Settings extends AcpProviderSettings>(
  descriptor: AcpProviderDescriptor<Settings>,
  settings: Settings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getAcpFallbackModels(descriptor, settings);
    const displayName = descriptor.presentation.displayName;
    return buildServerProvider({
      presentation: descriptor.presentation,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: `Checking ${displayName} availability...`,
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: `${displayName} is disabled in Threadlines settings.`,
          },
    });
  });
}

const withAcpProbeRuntime = <Settings extends AcpProviderSettings, A, E, R>(
  descriptor: AcpProviderDescriptor<Settings>,
  settings: Settings,
  useRuntime: (acp: AcpSessionRuntimeShape) => Effect.Effect<A, E, R>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makeAcpProviderRuntime(descriptor, {
      settings,
      environment,
      childProcessSpawner: spawner,
      cwd: process.cwd(),
      clientInfo: { name: "threadlines-provider-probe", version: "0.0.0" },
    });
    return yield* useRuntime(runtime);
  }).pipe(Effect.scoped);

/** Model catalog from one fresh session's `configOptions`. */
export const discoverAcpModels = <Settings extends AcpProviderSettings>(
  descriptor: AcpProviderDescriptor<Settings>,
  settings: Settings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  withAcpProbeRuntime(
    descriptor,
    settings,
    (acp) =>
      Effect.map(acp.start(), (started) =>
        buildAcpModelsFromConfigOptions({
          configOptions: started.sessionSetupResult.configOptions,
          mapping: mappingFor(descriptor),
          sharedCapabilities: descriptor.modelCapabilitiesVaryByModel !== true,
        }),
      ),
    environment,
  );

/**
 * Per-model capability probe for agents whose option set changes with the
 * selected model: opens one probe session per uncaptured model, selects it,
 * and reads the resulting options.
 */
export const discoverAcpModelCapabilities = <Settings extends AcpProviderSettings>(
  descriptor: AcpProviderDescriptor<Settings>,
  settings: Settings,
  existingModels: ReadonlyArray<ServerProviderModel>,
  environment: NodeJS.ProcessEnv = process.env,
) => {
  const mapping = mappingFor(descriptor);
  return withAcpProbeRuntime(
    descriptor,
    settings,
    (acp) =>
      Effect.gen(function* () {
        const started = yield* acp.start();
        const initialConfigOptions = started.sessionSetupResult.configOptions ?? [];
        const modelOption = findModelConfigOption(initialConfigOptions);
        const modelChoices = flattenSessionConfigSelectOptions(modelOption);
        if (!modelOption || modelChoices.length === 0) {
          return [];
        }

        const currentModelValue = selectConfigOptionCurrentValue(modelOption);
        const capabilitiesBySlug = new Map<string, ModelCapabilities>();
        if (currentModelValue) {
          capabilitiesBySlug.set(
            currentModelValue,
            mapping.capabilitiesFromConfigOptions(initialConfigOptions),
          );
        }

        const targetModelSlugs = new Set(
          existingModels
            .filter((model) => !model.isCustom && !hasAcpModelCapabilities(model))
            .map((model) => model.slug),
        );
        const assemble = () =>
          buildAcpDiscoveredModels(
            modelChoices.map((choice) => ({
              slug: choice.value,
              name: choice.name,
              capabilities: capabilitiesBySlug.get(choice.value) ?? EMPTY_ACP_MODEL_CAPABILITIES,
            })),
          );
        if (targetModelSlugs.size === 0) {
          return assemble();
        }

        const probed = yield* Effect.forEach(
          modelChoices,
          (choice) => {
            const modelSlug = choice.value;
            if (
              !modelSlug ||
              !targetModelSlugs.has(modelSlug) ||
              capabilitiesBySlug.has(modelSlug)
            ) {
              return Effect.succeed<readonly [string, ModelCapabilities] | undefined>(undefined);
            }
            return withAcpProbeRuntime(
              descriptor,
              settings,
              (probeAcp) =>
                Effect.gen(function* () {
                  const probeStarted = yield* probeAcp.start();
                  const probeConfigOptions = probeStarted.sessionSetupResult.configOptions ?? [];
                  const probeModelOption = findModelConfigOption(probeConfigOptions);
                  const probeCurrentModelValue = selectConfigOptionCurrentValue(probeModelOption);
                  const nextConfigOptions =
                    probeCurrentModelValue === modelSlug
                      ? probeConfigOptions
                      : yield* probeAcp
                          .setConfigOption(probeModelOption?.id ?? modelOption.id, modelSlug)
                          .pipe(
                            Effect.map((response) => response.configOptions ?? probeConfigOptions),
                          );
                  return [
                    modelSlug,
                    mapping.capabilitiesFromConfigOptions(nextConfigOptions),
                  ] as const;
                }),
              environment,
            ).pipe(
              Effect.timeout(ACP_MODEL_CAPABILITY_TIMEOUT),
              Effect.retry({ times: 3 }),
              Effect.withSpan("acp-model-capability-probe", {
                attributes: { "acp.provider": descriptor.driverKind, "acp.model": modelSlug },
              }),
              Effect.catchCause((cause) =>
                Effect.logWarning("ACP capability probe failed", {
                  provider: descriptor.driverKind,
                  modelSlug,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
          },
          { concurrency: ACP_MODEL_DISCOVERY_CONCURRENCY },
        );

        for (const entry of probed) {
          if (entry) {
            capabilitiesBySlug.set(entry[0], entry[1]);
          }
        }
        return assemble();
      }).pipe(Effect.withSpan("acp-model-capability-discovery")),
    environment,
  );
};

export function buildAcpProviderSnapshot<Settings extends AcpProviderSettings>(input: {
  readonly descriptor: AcpProviderDescriptor<Settings>;
  readonly checkedAt: string;
  readonly settings: Settings;
  readonly probe: AcpProviderProbeOutcome;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly discoveryWarning?: string;
}): ServerProviderDraft {
  const message = [input.probe.message, input.discoveryWarning]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" ");
  const discovered = input.discoveredModels ?? [];
  return buildServerProvider({
    presentation: input.descriptor.presentation,
    enabled: input.settings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      discovered,
      input.descriptor.driverKind,
      input.settings.customModels,
      EMPTY_ACP_MODEL_CAPABILITIES,
    ),
    ...(discovered.length > 0 ? { modelCatalogSource: "live" as const } : {}),
    probe: {
      installed: input.probe.installed,
      version: input.probe.version,
      status:
        input.discoveryWarning && input.probe.status === "ready" ? "warning" : input.probe.status,
      ...(input.probe.statusReason ? { statusReason: input.probe.statusReason } : {}),
      auth: input.probe.auth,
      ...(input.probe.accountUsage ? { accountUsage: input.probe.accountUsage } : {}),
      ...(message ? { message } : {}),
    },
  });
}

export const checkAcpProviderStatus = <Settings extends AcpProviderSettings>(
  descriptor: AcpProviderDescriptor<Settings>,
  settings: Settings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ServerProviderDraft, never, ProbeEnv> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const displayName = descriptor.presentation.displayName;

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: descriptor.presentation,
        enabled: false,
        checkedAt,
        models: getAcpFallbackModels(descriptor, settings),
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: `${displayName} is disabled in Threadlines settings.`,
        },
      });
    }

    const probe = yield* descriptor.probe(settings, environment);
    const discoveryTimeoutMs = descriptor.modelDiscoveryTimeoutMs ?? ACP_MODEL_DISCOVERY_TIMEOUT_MS;

    let discoveredModels: ReadonlyArray<ServerProviderModel> = [];
    let discoveryWarning: string | undefined;
    if (probe.installed && probe.auth.status !== "unauthenticated" && !probe.skipModelDiscovery) {
      const discoveryExit = yield* Effect.exit(
        discoverAcpModels(descriptor, settings, environment).pipe(
          Effect.timeoutOption(discoveryTimeoutMs),
        ),
      );
      if (Exit.isFailure(discoveryExit)) {
        yield* Effect.logWarning("ACP model discovery failed", {
          provider: descriptor.driverKind,
          cause: Cause.pretty(discoveryExit.cause),
        });
        discoveryWarning = `${displayName} ACP model discovery failed. Check server logs for details.`;
      } else if (Option.isNone(discoveryExit.value)) {
        discoveryWarning = `${displayName} ACP model discovery timed out after ${discoveryTimeoutMs}ms.`;
      } else if (discoveryExit.value.value.length === 0) {
        discoveryWarning = `${displayName} ACP model discovery returned no built-in models.`;
      } else {
        discoveredModels = discoveryExit.value.value;
      }
    }

    return buildAcpProviderSnapshot({
      descriptor,
      checkedAt,
      settings,
      probe,
      discoveredModels,
      ...(discoveryWarning ? { discoveryWarning } : {}),
    });
  }).pipe(Effect.withSpan("checkAcpProviderStatus"));

export function hasUncapturedAcpModels(snapshot: Pick<ServerProvider, "models">): boolean {
  return snapshot.models.some((model) => !model.isCustom && !hasAcpModelCapabilities(model));
}

/**
 * Background enrichment used as `makeManagedServerProvider.enrichSnapshot`:
 * folds in the version advisory, then (only for agents whose options vary by
 * model) probes each uncaptured model's capabilities and republishes.
 */
export const enrichAcpSnapshot = <Settings extends AcpProviderSettings>(input: {
  readonly descriptor: AcpProviderDescriptor<Settings>;
  readonly settings: Settings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly stampIdentity: (snapshot: ServerProvider) => ServerProvider;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const { descriptor, settings, snapshot, publishSnapshot, stampIdentity } = input;
  const displayName = descriptor.presentation.displayName;

  const enrichVersionAdvisory = enrichProviderSnapshotWithVersionAdvisory(
    snapshot,
    input.maintenanceCapabilities,
  ).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enriched) =>
      publishSnapshot(stampIdentity(enriched)).pipe(Effect.as(enriched)),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning(`${displayName} version advisory enrichment failed`, {
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(snapshot)),
    ),
  );

  return enrichVersionAdvisory.pipe(
    Effect.flatMap((baseSnapshot) => {
      if (
        descriptor.modelCapabilitiesVaryByModel !== true ||
        !settings.enabled ||
        baseSnapshot.auth.status === "unauthenticated" ||
        !hasUncapturedAcpModels(baseSnapshot)
      ) {
        return Effect.void;
      }
      return discoverAcpModelCapabilities(
        descriptor,
        settings,
        baseSnapshot.models,
        input.environment,
      ).pipe(
        Effect.flatMap((discoveredModels) =>
          discoveredModels.length === 0
            ? Effect.void
            : publishSnapshot(
                stampIdentity({
                  ...baseSnapshot,
                  models: providerModelsFromSettings(
                    discoveredModels,
                    descriptor.driverKind,
                    settings.customModels,
                    EMPTY_ACP_MODEL_CAPABILITIES,
                  ),
                }),
              ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning(`${displayName} ACP background capability enrichment failed`, {
            models: baseSnapshot.models.map((model) => model.slug),
            cause: Cause.pretty(cause),
          }).pipe(Effect.asVoid),
        ),
      );
    }),
  );
};
