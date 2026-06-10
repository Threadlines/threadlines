import type {
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerSettings,
  UnifiedSettings,
} from "@t3tools/contracts";
import { defaultInstanceIdForDriver } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import * as Equal from "effect/Equal";

function collapseOtelSignalsUrl(input: {
  readonly tracesUrl: string;
  readonly metricsUrl: string;
}): string | null {
  const tracesSuffix = "/traces";
  const metricsSuffix = "/metrics";
  if (!input.tracesUrl.endsWith(tracesSuffix) || !input.metricsUrl.endsWith(metricsSuffix)) {
    return null;
  }

  const tracesBase = input.tracesUrl.slice(0, -tracesSuffix.length);
  const metricsBase = input.metricsUrl.slice(0, -metricsSuffix.length);
  if (tracesBase !== metricsBase) {
    return null;
  }

  return `${tracesBase}/{traces,metrics}`;
}

export function formatDiagnosticsDescription(input: {
  readonly localTracingEnabled: boolean;
  readonly otlpTracesEnabled: boolean;
  readonly otlpTracesUrl?: string | undefined;
  readonly otlpMetricsEnabled: boolean;
  readonly otlpMetricsUrl?: string | undefined;
}): string {
  const mode = input.localTracingEnabled ? "Local trace file" : "Terminal logs only";
  const tracesUrl = input.otlpTracesEnabled ? input.otlpTracesUrl : undefined;
  const metricsUrl = input.otlpMetricsEnabled ? input.otlpMetricsUrl : undefined;

  if (tracesUrl && metricsUrl) {
    const collapsedUrl = collapseOtelSignalsUrl({ tracesUrl, metricsUrl });
    return collapsedUrl
      ? `${mode}. Exporting OTEL to ${collapsedUrl}.`
      : `${mode}. Exporting OTEL traces to ${tracesUrl} and metrics to ${metricsUrl}.`;
  }

  if (tracesUrl) {
    return `${mode}. Exporting OTEL traces to ${tracesUrl}.`;
  }

  if (metricsUrl) {
    return `${mode}. Exporting OTEL metrics to ${metricsUrl}.`;
  }

  return `${mode}.`;
}

type ProviderSettingsState = Pick<ServerSettings, "providers" | "providerInstances">;
type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];

export interface ProviderSettingsRow {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly isDirty?: boolean;
}

function readLegacyProviderConfig(
  settings: ProviderSettingsState,
  driver: ProviderDriverKind,
): LegacyProviderSettings | undefined {
  const legacyProviders = settings.providers as Record<string, LegacyProviderSettings | undefined>;
  return legacyProviders[driver];
}

function readDefaultLegacyProviderConfig(
  driver: ProviderDriverKind,
): LegacyProviderSettings | undefined {
  const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
    string,
    LegacyProviderSettings | undefined
  >;
  return defaultLegacyProviders[driver];
}

export function deriveProviderSettingsRows(input: {
  readonly settings: ProviderSettingsState;
  readonly maintainedDriverKinds: ReadonlyArray<ProviderDriverKind>;
}): ReadonlyArray<ProviderSettingsRow> {
  const visibleDriverKinds = [...input.maintainedDriverKinds];

  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(input.settings.providerInstances ?? {})) {
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const rows: ProviderSettingsRow[] = [];

  for (const driver of visibleDriverKinds) {
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = input.settings.providerInstances?.[defaultInstanceId];
    const legacyConfig = readLegacyProviderConfig(input.settings, driver);
    const defaultLegacyConfig = readDefaultLegacyProviderConfig(driver);

    const effectiveInstance =
      explicitInstance ??
      (legacyConfig !== undefined
        ? ({
            driver,
            enabled: legacyConfig.enabled,
            config: legacyConfig,
          } satisfies ProviderInstanceConfig)
        : undefined);
    if (effectiveInstance === undefined) {
      continue;
    }
    const isDirty =
      explicitInstance !== undefined ||
      (legacyConfig !== undefined &&
        defaultLegacyConfig !== undefined &&
        !Equal.equals(legacyConfig, defaultLegacyConfig));

    rows.push({
      instanceId: defaultInstanceId,
      instance: effectiveInstance,
      driver,
      isDefault: true,
      isDirty,
    });

    for (const [id, instance] of instancesByDriver.get(driver) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({ instanceId: id, instance, driver: instance.driver, isDefault: false });
    }
  }

  return rows;
}

export function buildProviderInstanceUpdatePatch(input: {
  readonly settings: Pick<ServerSettings, "providers" | "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly textGenerationModelSelection?:
    | ServerSettings["textGenerationModelSelection"]
    | undefined;
}): Partial<UnifiedSettings> {
  type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];
  const legacyProviderDefaults = DEFAULT_UNIFIED_SETTINGS.providers as Record<
    string,
    LegacyProviderSettings | undefined
  >;
  const legacyProviderDefault = input.isDefault ? legacyProviderDefaults[input.driver] : undefined;
  return {
    ...(legacyProviderDefault !== undefined
      ? {
          providers: {
            ...input.settings.providers,
            [input.driver]: legacyProviderDefault,
          } as ServerSettings["providers"],
        }
      : {}),
    providerInstances: {
      ...input.settings.providerInstances,
      [input.instanceId]: input.instance,
    },
    ...(input.textGenerationModelSelection !== undefined
      ? { textGenerationModelSelection: input.textGenerationModelSelection }
      : {}),
  };
}
