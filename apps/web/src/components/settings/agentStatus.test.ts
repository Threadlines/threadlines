import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveAgentStatus } from "./agentStatus";

const CODEX = ProviderDriverKind.make("codex");
const CURSOR = ProviderDriverKind.make("cursor");

function snapshot(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    driver: CODEX,
    instanceId: ProviderInstanceId.make("codex"),
    enabled: true,
    installed: true,
    version: "0.160.0",
    status: "ready",
    auth: { status: "authenticated", label: "ChatGPT Pro" },
    checkedAt: "2026-10-04T00:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: [],
    ...overrides,
  };
}

const INSTALL_ADVISORY = {
  status: "unknown",
  currentVersion: null,
  latestVersion: null,
  updateCommand: null,
  canUpdate: false,
  installCommand: "npm install -g @openai/codex",
  canInstall: true,
  checkedAt: null,
  message: null,
} as const satisfies ServerProvider["versionAdvisory"];

describe("deriveAgentStatus", () => {
  it("names one state per situation", () => {
    const status = (snap: ServerProvider | undefined, enabled = true, driverKind = CODEX) =>
      deriveAgentStatus({ enabled, driverKind, snapshot: snap }).kind;

    expect(status(snapshot())).toBe("ready");
    expect(status(snapshot({ auth: { status: "unauthenticated" } }))).toBe("needsSignIn");
    expect(
      status(snapshot({ installed: false, auth: { status: "unknown" }, status: "error" })),
    ).toBe("notInstalled");
    expect(
      status(
        snapshot({
          installed: false,
          auth: { status: "unknown" },
          versionAdvisory: INSTALL_ADVISORY,
          updateState: {
            status: "running",
            startedAt: null,
            finishedAt: null,
            message: null,
            output: null,
          },
        }),
      ),
    ).toBe("installing");
    expect(status(snapshot({ status: "error", message: "OpenCode 1.0 is too old." }))).toBe(
      "problem",
    );
  });

  it("never calls a provisional snapshot ready or missing", () => {
    // Codex's pending snapshot says installed: false, ACP's says true with
    // unknown auth; neither has been checked yet.
    const pendingCodex = snapshot({
      installed: false,
      status: "warning",
      statusReason: "provider_probe_pending",
      auth: { status: "unknown" },
    });
    const pendingCursor = snapshot({
      driver: CURSOR,
      instanceId: ProviderInstanceId.make("cursor"),
      installed: true,
      status: "warning",
      statusReason: "provider_probe_pending",
      auth: { status: "unknown" },
    });

    expect(deriveAgentStatus({ enabled: true, driverKind: CODEX, snapshot: pendingCodex })).toEqual(
      { kind: "checking" },
    );
    expect(
      deriveAgentStatus({ enabled: true, driverKind: CURSOR, snapshot: pendingCursor }),
    ).toEqual({ kind: "checking" });
    // Just turned on: the snapshot still says off until the server catches up.
    expect(
      deriveAgentStatus({
        enabled: true,
        driverKind: CODEX,
        snapshot: snapshot({ enabled: false }),
      }),
    ).toEqual({ kind: "checking" });
  });

  it("reports what the file-only look found for a turned-off agent", () => {
    const off = snapshot({
      enabled: false,
      installed: false,
      status: "disabled",
      auth: { status: "unknown" },
      detection: { status: "found", path: "/usr/local/bin/codex" },
    });

    expect(deriveAgentStatus({ enabled: false, driverKind: CODEX, snapshot: off })).toEqual({
      kind: "off",
      detection: { status: "found", path: "/usr/local/bin/codex" },
    });
    // Just turned off: a snapshot still describing the running agent carries no detection yet.
    expect(deriveAgentStatus({ enabled: false, driverKind: CODEX, snapshot: snapshot() })).toEqual({
      kind: "off",
      detection: null,
    });
  });
});
