import { describe, expect, it } from "vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";

import { shouldRenderProviderStatusBanner } from "./ProviderStatusBanner";

function makeProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    auth: { status: "unknown" },
    checkedAt: "2026-06-01T12:00:00.000Z",
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
    message: "Codex provider status check timed out.",
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
