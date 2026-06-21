import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@threadlines/contracts";
import { describe, expect, it } from "vitest";
import {
  buildArchivedThreadBulkDeleteConfirmationMessage,
  buildProviderInstanceUpdatePatch,
  deriveProviderSettingsRows,
  formatArchivedThreadDeleteAgeLabel,
  formatDiagnosticsDescription,
  isArchivedThreadOlderThan,
  parseArchivedThreadDeleteAgeDays,
} from "./SettingsPanels.logic";

const MAINTAINED_DRIVER_KINDS = [
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("claudeAgent"),
] as const;

describe("formatDiagnosticsDescription", () => {
  it("collapses trace and metric URLs that share the same OTEL base path", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      }),
    ).toBe("Local trace file. Exporting OTEL to http://localhost:4318/v1/{traces,metrics}.");
  });

  it("keeps separate trace and metric URLs when their base paths differ", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:9000/v1/metrics",
      }),
    ).toBe(
      "Local trace file. Exporting OTEL traces to http://localhost:4318/v1/traces and metrics to http://localhost:9000/v1/metrics.",
    );
  });

  it("omits OTEL text when no exporter is enabled", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      }),
    ).toBe("Local trace file.");
  });
});

describe("archived thread delete helpers", () => {
  it("parses and formats supported archived-thread delete ages", () => {
    expect(parseArchivedThreadDeleteAgeDays("90")).toBe(90);
    expect(parseArchivedThreadDeleteAgeDays("7")).toBeNull();
    expect(formatArchivedThreadDeleteAgeLabel(180)).toBe("180+ days");
  });

  it("selects only threads archived at least the requested number of days ago", () => {
    const nowMs = Date.parse("2026-06-21T00:00:00.000Z");

    expect(
      isArchivedThreadOlderThan({
        archivedAt: "2026-03-23T00:00:00.000Z",
        olderThanDays: 90,
        nowMs,
      }),
    ).toBe(true);
    expect(
      isArchivedThreadOlderThan({
        archivedAt: "2026-03-24T00:00:00.000Z",
        olderThanDays: 90,
        nowMs,
      }),
    ).toBe(false);
    expect(
      isArchivedThreadOlderThan({
        archivedAt: null,
        olderThanDays: 90,
        nowMs,
      }),
    ).toBe(false);
  });

  it("builds count-based confirmation copy for bulk archive deletion", () => {
    const message = buildArchivedThreadBulkDeleteConfirmationMessage({
      days: 90,
      groups: [
        { projectName: "Alpha", count: 2 },
        { projectName: "Beta", count: 1 },
      ],
    });

    expect(message).toContain("Delete 3 threads archived for 90+ days?");
    expect(message).toContain("This cannot be undone.");
    expect(message).toContain("- Alpha: 2 threads");
    expect(message).toContain("- Beta: 1 thread");
  });
});

describe("buildProviderInstanceUpdatePatch", () => {
  it("promotes an edited default provider into providerInstances and resets the legacy provider", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        binaryPath: "/opt/t3/codex",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            binaryPath: "/legacy/codex",
          },
        },
      },
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: true,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("updates custom instances without touching legacy provider settings", () => {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        homePath: "/Users/example/.codex-personal",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: false,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers).toBeUndefined();
  });
});

describe("deriveProviderSettingsRows", () => {
  it("renders maintained provider defaults without advertising deprecated defaults", () => {
    const rows = deriveProviderSettingsRows({
      settings: DEFAULT_SERVER_SETTINGS,
      maintainedDriverKinds: MAINTAINED_DRIVER_KINDS,
    });

    expect(rows.map((row) => row.instanceId)).toEqual([
      ProviderInstanceId.make("codex"),
      ProviderInstanceId.make("claudeAgent"),
    ]);
  });

  it("omits dirty legacy Cursor and OpenCode defaults", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        cursor: {
          ...DEFAULT_SERVER_SETTINGS.providers.cursor,
          enabled: true,
        },
        opencode: {
          ...DEFAULT_SERVER_SETTINGS.providers.opencode,
          serverUrl: "http://127.0.0.1:4096",
        },
      },
    };

    const rows = deriveProviderSettingsRows({
      settings,
      maintainedDriverKinds: MAINTAINED_DRIVER_KINDS,
    });

    expect(rows.map((row) => row.instanceId)).toEqual([
      ProviderInstanceId.make("codex"),
      ProviderInstanceId.make("claudeAgent"),
    ]);
  });

  it("omits explicit deprecated default provider instances", () => {
    const cursorId = ProviderInstanceId.make("cursor");
    const cursorInstance = {
      driver: ProviderDriverKind.make("cursor"),
      enabled: false,
      displayName: "Old Cursor",
    } satisfies ProviderInstanceConfig;

    const rows = deriveProviderSettingsRows({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [cursorId]: cursorInstance,
        },
      },
      maintainedDriverKinds: MAINTAINED_DRIVER_KINDS,
    });

    expect(rows.map((row) => row.instanceId)).toEqual([
      ProviderInstanceId.make("codex"),
      ProviderInstanceId.make("claudeAgent"),
    ]);
  });

  it("omits custom deprecated instances", () => {
    const cursorWorkId = ProviderInstanceId.make("cursor_work");
    const rows = deriveProviderSettingsRows({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [cursorWorkId]: {
            driver: ProviderDriverKind.make("cursor"),
            displayName: "Cursor Work",
          },
        },
      },
      maintainedDriverKinds: MAINTAINED_DRIVER_KINDS,
    });

    expect(rows.map((row) => row.instanceId)).toEqual([
      ProviderInstanceId.make("codex"),
      ProviderInstanceId.make("claudeAgent"),
    ]);
  });
});
