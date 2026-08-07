import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";

import {
  PROVIDER_STATUS_SLOW_NOTICE_DELAY_MS,
  shouldShowProviderStatusNotice,
} from "./providerStatusNotice";

const CHECKED_AT_MS = Date.UTC(2026, 5, 1, 12, 0, 0);
const CHECKED_AT_ISO = new Date(CHECKED_AT_MS).toISOString();

function makeProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    auth: { status: "unknown" },
    checkedAt: CHECKED_AT_ISO,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    displayName: "Codex",
    installed: true,
    instanceId: ProviderInstanceId.make("codex"),
    models: [],
    slashCommands: [],
    skills: [],
    status: "warning",
    version: null,
    message: "Codex provider has limited availability.",
    ...overrides,
  };
}

describe("shouldShowProviderStatusNotice", () => {
  it("does not show for absent, ready, or disabled provider snapshots", () => {
    expect(shouldShowProviderStatusNotice(null)).toBe(false);
    expect(shouldShowProviderStatusNotice(makeProvider({ status: "ready" }))).toBe(false);
    expect(shouldShowProviderStatusNotice(makeProvider({ status: "disabled" }))).toBe(false);
  });

  it("suppresses warning-level provider probes while a turn is active", () => {
    expect(
      shouldShowProviderStatusNotice(makeProvider({ status: "warning" }), {
        activeTurnInProgress: true,
      }),
    ).toBe(false);
  });

  it("hides pending Codex probe status before the slow notice delay", () => {
    expect(
      shouldShowProviderStatusNotice(
        makeProvider({
          statusReason: "provider_probe_pending",
        }),
        {
          nowMs: CHECKED_AT_MS + PROVIDER_STATUS_SLOW_NOTICE_DELAY_MS - 1,
        },
      ),
    ).toBe(false);
  });

  it("shows pending Codex probe status after the slow notice delay", () => {
    expect(
      shouldShowProviderStatusNotice(
        makeProvider({
          statusReason: "provider_probe_pending",
        }),
        {
          nowMs: CHECKED_AT_MS + PROVIDER_STATUS_SLOW_NOTICE_DELAY_MS,
        },
      ),
    ).toBe(true);
  });

  it("shows Codex probe timeouts immediately", () => {
    expect(
      shouldShowProviderStatusNotice(
        makeProvider({
          statusReason: "provider_probe_timeout",
        }),
        {
          nowMs: CHECKED_AT_MS,
        },
      ),
    ).toBe(true);
  });

  it("still shows warning-level provider probes while idle", () => {
    expect(
      shouldShowProviderStatusNotice(makeProvider({ status: "warning" }), {
        activeTurnInProgress: false,
      }),
    ).toBe(true);
  });

  it("still shows provider errors while a turn is active", () => {
    expect(
      shouldShowProviderStatusNotice(makeProvider({ status: "error" }), {
        activeTurnInProgress: true,
      }),
    ).toBe(true);
  });
});
