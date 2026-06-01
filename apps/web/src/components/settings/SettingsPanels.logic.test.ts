import {
  DEFAULT_SERVER_SETTINGS,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  buildProviderInstanceUpdatePatch,
  deriveProviderSettingsRows,
  formatDiagnosticsDescription,
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

  it("preserves dirty legacy Cursor and OpenCode defaults as deprecated rows", () => {
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

    const cursor = rows.find((row) => row.instanceId === ProviderInstanceId.make("cursor"));
    const opencode = rows.find((row) => row.instanceId === ProviderInstanceId.make("opencode"));

    expect(rows.map((row) => row.instanceId)).toEqual([
      ProviderInstanceId.make("codex"),
      ProviderInstanceId.make("claudeAgent"),
      ProviderInstanceId.make("cursor"),
      ProviderInstanceId.make("opencode"),
    ]);
    expect(cursor).toMatchObject({
      driver: ProviderDriverKind.make("cursor"),
      isDefault: true,
      isDirty: true,
      instance: {
        driver: ProviderDriverKind.make("cursor"),
        config: { enabled: true },
      },
    });
    expect(opencode).toMatchObject({
      driver: ProviderDriverKind.make("opencode"),
      isDefault: true,
      isDirty: true,
      instance: {
        driver: ProviderDriverKind.make("opencode"),
        config: { serverUrl: "http://127.0.0.1:4096" },
      },
    });
  });

  it("treats explicit deprecated default provider instances as default rows", () => {
    const cursorId = defaultInstanceIdForDriver(ProviderDriverKind.make("cursor"));
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

    expect(rows.find((row) => row.instanceId === cursorId)).toMatchObject({
      instance: cursorInstance,
      isDefault: true,
      isDirty: true,
    });
  });

  it("keeps custom deprecated instances without adding a default deprecated slot", () => {
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
      cursorWorkId,
    ]);
  });
});
