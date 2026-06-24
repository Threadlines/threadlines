import { describe, expect, it } from "vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";

import {
  getProviderStatusNoticeKind,
  PROVIDER_STATUS_SLOW_NOTICE_DELAY_MS,
  shouldRenderProviderStatusBanner,
} from "./ProviderStatusBanner";

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

describe("shouldRenderProviderStatusBanner", () => {
  it("does not render for absent, ready, or disabled provider snapshots", () => {
    expect(shouldRenderProviderStatusBanner(null)).toBe(false);
    expect(shouldRenderProviderStatusBanner(makeProvider({ status: "ready" }))).toBe(false);
    expect(shouldRenderProviderStatusBanner(makeProvider({ status: "disabled" }))).toBe(false);
  });

  it("suppresses warning-level provider probes while a turn is active", () => {
    expect(
      shouldRenderProviderStatusBanner(makeProvider({ status: "warning" }), {
        activeTurnInProgress: true,
      }),
    ).toBe(false);
  });

  it("hides pending Codex probe status before the slow notice delay", () => {
    expect(
      shouldRenderProviderStatusBanner(
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
    const provider = makeProvider({
      statusReason: "provider_probe_pending",
    });

    expect(
      shouldRenderProviderStatusBanner(provider, {
        nowMs: CHECKED_AT_MS + PROVIDER_STATUS_SLOW_NOTICE_DELAY_MS,
      }),
    ).toBe(true);
    expect(
      getProviderStatusNoticeKind(provider, {
        nowMs: CHECKED_AT_MS + PROVIDER_STATUS_SLOW_NOTICE_DELAY_MS,
      }),
    ).toBe("compact");
  });

  it("uses compact treatment for Codex probe timeouts", () => {
    expect(
      getProviderStatusNoticeKind(
        makeProvider({
          statusReason: "provider_probe_timeout",
        }),
        {
          nowMs: CHECKED_AT_MS,
        },
      ),
    ).toBe("compact");
  });

  it("still renders warning-level provider probes while idle", () => {
    expect(
      shouldRenderProviderStatusBanner(makeProvider({ status: "warning" }), {
        activeTurnInProgress: false,
      }),
    ).toBe(true);
  });

  it("still renders provider errors while a turn is active", () => {
    expect(
      shouldRenderProviderStatusBanner(makeProvider({ status: "error" }), {
        activeTurnInProgress: true,
      }),
    ).toBe(true);
  });
});
