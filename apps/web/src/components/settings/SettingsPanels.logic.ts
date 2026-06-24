import type {
  AutoArchiveInactiveThreadsDays,
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerSettings,
  UnifiedSettings,
} from "@threadlines/contracts";
import {
  AUTO_ARCHIVE_INACTIVE_THREADS_DAY_OPTIONS,
  defaultInstanceIdForDriver,
} from "@threadlines/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@threadlines/contracts/settings";
import * as Equal from "effect/Equal";

export const ARCHIVED_THREAD_DELETE_AGE_OPTIONS = [30, 90, 180, 365] as const;
export type ArchivedThreadDeleteAgeDays = (typeof ARCHIVED_THREAD_DELETE_AGE_OPTIONS)[number];

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

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
  readonly textGenerationBackupModelSelection?:
    | ServerSettings["textGenerationBackupModelSelection"]
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
    ...(input.textGenerationBackupModelSelection !== undefined
      ? { textGenerationBackupModelSelection: input.textGenerationBackupModelSelection }
      : {}),
  };
}

export function formatThreadCount(count: number): string {
  return count === 1 ? "1 thread" : `${count} threads`;
}

export function formatAutoArchiveDaysLabel(days: AutoArchiveInactiveThreadsDays): string {
  return days === 0 ? "Off" : `${days} days`;
}

export function formatAutoArchiveCandidateSummary(
  count: number,
  days: AutoArchiveInactiveThreadsDays,
) {
  if (days === 0) {
    return `${formatThreadCount(count)} inactive for 30+ days.`;
  }
  return `${formatThreadCount(count)} inactive for ${days}+ days.`;
}

export function parseAutoArchiveDays(value: string): AutoArchiveInactiveThreadsDays | null {
  const parsed = Number(value);
  return AUTO_ARCHIVE_INACTIVE_THREADS_DAY_OPTIONS.includes(
    parsed as AutoArchiveInactiveThreadsDays,
  )
    ? (parsed as AutoArchiveInactiveThreadsDays)
    : null;
}

export function formatArchivedThreadDeleteAgeLabel(days: ArchivedThreadDeleteAgeDays): string {
  return `${days}+ days`;
}

export function parseArchivedThreadDeleteAgeDays(
  value: string,
): ArchivedThreadDeleteAgeDays | null {
  const parsed = Number(value);
  return ARCHIVED_THREAD_DELETE_AGE_OPTIONS.includes(parsed as ArchivedThreadDeleteAgeDays)
    ? (parsed as ArchivedThreadDeleteAgeDays)
    : null;
}

export function isArchivedThreadOlderThan(input: {
  readonly archivedAt: string | null;
  readonly olderThanDays: ArchivedThreadDeleteAgeDays;
  readonly nowMs?: number;
}): boolean {
  if (input.archivedAt === null) {
    return false;
  }

  const archivedAtMs = Date.parse(input.archivedAt);
  if (!Number.isFinite(archivedAtMs)) {
    return false;
  }

  return archivedAtMs <= (input.nowMs ?? Date.now()) - input.olderThanDays * MS_PER_DAY;
}

export function buildArchivedThreadBulkDeleteConfirmationMessage(input: {
  readonly days: ArchivedThreadDeleteAgeDays;
  readonly groups: ReadonlyArray<{ readonly projectName: string | null; readonly count: number }>;
}): string {
  const count = input.groups.reduce((total, group) => total + group.count, 0);
  const projectLines = input.groups.slice(0, 6).map((group) => {
    const projectName = group.projectName ?? "Unknown project";
    return `- ${projectName}: ${formatThreadCount(group.count)}`;
  });
  const remainingProjectCount = input.groups.length - projectLines.length;

  return [
    `Delete ${formatThreadCount(count)} archived for ${input.days}+ days?`,
    "This permanently clears conversation history for these archived threads.",
    "This cannot be undone.",
    "",
    ...projectLines,
    ...(remainingProjectCount > 0 ? [`- ${remainingProjectCount} more projects`] : []),
  ].join("\n");
}
