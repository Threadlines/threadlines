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
import { placeById, type PlaceId } from "@threadlines/shared/appPlaces";
import * as Equal from "effect/Equal";

export const ARCHIVED_THREAD_DELETE_AGE_OPTIONS = [30, 90, 180, 365] as const;
export type ArchivedThreadDeleteAgeDays = (typeof ARCHIVED_THREAD_DELETE_AGE_OPTIONS)[number];

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/** The settings Restore defaults can turn back on for agents. Each one's default lets them. */
const AGENT_ABILITY_PLACES = [
  "threads.enableRooms",
  "threads.agentPages",
  "threads.commandRequests",
  "threads.startWhileTyping",
  "threads.agentInvites",
  "threads.agentThreads",
] as const satisfies ReadonlyArray<PlaceId>;

/**
 * What Restore defaults would turn back on for agents, in the words of each
 * setting's row. A choice the user set to let agents do more (Without asking)
 * isn't here: going back to its default takes reach away.
 */
function agentAbilitiesBackOn(
  settings: ServerSettings,
): ReadonlyArray<{ readonly title: string; readonly restoredTo: string }> {
  return AGENT_ABILITY_PLACES.flatMap((id) => {
    const { title, value } = placeById(id);
    if (value?.kind === "switch") {
      return !value.read(settings) && value.read(DEFAULT_UNIFIED_SETTINGS)
        ? [{ title, restoredTo: "On" }]
        : [];
    }
    if (value?.kind === "choice") {
      const restored = value.read(DEFAULT_UNIFIED_SETTINGS);
      return value.read(settings) === "off" && restored !== "off"
        ? [{ title, restoredTo: value.options[restored] ?? restored }]
        : [];
    }
    return [];
  });
}

/**
 * What the Restore defaults dialog asks. What the restore gives agents back is
 * listed on its own, because a setting turned off on purpose shouldn't come
 * back on under a plain "reset".
 */
export function buildRestoreDefaultsConfirmationMessage(input: {
  readonly changedSettingLabels: ReadonlyArray<string>;
  readonly settings: ServerSettings;
}): string {
  const abilities = agentAbilitiesBackOn(input.settings);
  const others = input.changedSettingLabels.filter(
    (label) => !abilities.some((ability) => ability.title === label),
  );
  return [
    "Restore default settings?",
    ...(abilities.length > 0
      ? [
          "",
          "Agents get these abilities back:",
          ...abilities.map((ability) => `${ability.title}: ${ability.restoredTo}`),
        ]
      : []),
    ...(others.length > 0
      ? [
          "",
          `${abilities.length > 0 ? "This will also reset" : "This will reset"}: ${others.join(", ")}.`,
        ]
      : []),
  ].join("\n");
}

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

/**
 * The reset-to-defaults control is for real changes: binary path, custom
 * models, name, color, environment. The on/off switch shows its own state, so
 * turning an opt-in provider (fx, Cursor) on or off alone is not a change.
 */
function withoutEnabled(config: unknown): unknown {
  if (typeof config !== "object" || config === null) {
    return config;
  }
  const { enabled: _enabled, ...rest } = config as Record<string, unknown>;
  return rest;
}

function isDefaultEquivalentInstance(
  instance: ProviderInstanceConfig,
  defaultConfig: LegacyProviderSettings | undefined,
): boolean {
  const { driver: _driver, enabled: _enabled, config, ...extras } = instance;
  return (
    Object.values(extras).every((value) => value === undefined) &&
    defaultConfig !== undefined &&
    Equal.equals(withoutEnabled(config ?? {}), withoutEnabled(defaultConfig))
  );
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
    // A driver with no row of its own (community agents) still lists the
    // instances it has.
    if (effectiveInstance !== undefined) {
      const isDirty =
        explicitInstance !== undefined
          ? !isDefaultEquivalentInstance(explicitInstance, defaultLegacyConfig)
          : legacyConfig !== undefined &&
            defaultLegacyConfig !== undefined &&
            !Equal.equals(withoutEnabled(legacyConfig), withoutEnabled(defaultLegacyConfig));

      rows.push({
        instanceId: defaultInstanceId,
        instance: effectiveInstance,
        driver,
        isDefault: true,
        isDirty,
      });
    }

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

export const ARCHIVED_THREADS_PAGE_SIZE = 50;

/** Newest archive first; threads without an archive time fall back to creation time. */
export function compareArchivedThreadsNewestFirst(
  left: { readonly id: string; readonly archivedAt: string | null; readonly createdAt: string },
  right: { readonly id: string; readonly archivedAt: string | null; readonly createdAt: string },
): number {
  const leftKey = left.archivedAt ?? left.createdAt;
  const rightKey = right.archivedAt ?? right.createdAt;
  return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
}

/**
 * Narrows the archive list by project and search text. Every word in the query must
 * appear in the thread title or its project name, case-insensitively.
 */
export function filterArchivedThreads<
  T extends {
    readonly title: string;
    readonly project: { readonly key: string; readonly name: string };
  },
>(
  threads: ReadonlyArray<T>,
  filter: { readonly query: string; readonly projectKey: string | null },
): ReadonlyArray<T> {
  const terms = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0 && filter.projectKey === null) {
    return threads;
  }
  return threads.filter((thread) => {
    if (filter.projectKey !== null && thread.project.key !== filter.projectKey) {
      return false;
    }
    const haystack = `${thread.title} ${thread.project.name}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
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
