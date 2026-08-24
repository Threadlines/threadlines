import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";

import {
  PROVIDER_STATUS_SLOW_NOTICE_DELAY_MS,
  PROVIDER_STATUS_TIMEOUT_NOTICE_DELAY_MS,
  resolveProviderStatusNoticeActions,
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

  it("hides pending non-Codex probe status before the slow notice delay", () => {
    expect(
      shouldShowProviderStatusNotice(
        makeProvider({
          displayName: "Claude",
          driver: ProviderDriverKind.make("claudeAgent"),
          instanceId: ProviderInstanceId.make("claudeAgent"),
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

  it("hides provider probe timeouts before the timeout notice delay", () => {
    expect(
      shouldShowProviderStatusNotice(
        makeProvider({
          statusReason: "provider_probe_timeout",
        }),
        {
          nowMs: CHECKED_AT_MS + PROVIDER_STATUS_TIMEOUT_NOTICE_DELAY_MS - 1,
        },
      ),
    ).toBe(false);
  });

  it("shows provider probe timeouts after the timeout notice delay", () => {
    expect(
      shouldShowProviderStatusNotice(
        makeProvider({
          statusReason: "provider_probe_timeout",
        }),
        {
          nowMs: CHECKED_AT_MS + PROVIDER_STATUS_TIMEOUT_NOTICE_DELAY_MS,
        },
      ),
    ).toBe(true);
  });

  it("suppresses recoverable provider probe timeouts while a turn is active", () => {
    expect(
      shouldShowProviderStatusNotice(makeProvider({ statusReason: "provider_probe_timeout" }), {
        activeTurnInProgress: true,
        nowMs: CHECKED_AT_MS + PROVIDER_STATUS_TIMEOUT_NOTICE_DELAY_MS,
      }),
    ).toBe(false);
  });

  it("still shows non-probe provider warnings while idle", () => {
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

describe("resolveProviderStatusNoticeActions", () => {
  it("offers only sign-in when the provider is unauthenticated", () => {
    expect(
      resolveProviderStatusNoticeActions(
        makeProvider({ status: "error", auth: { status: "unauthenticated" } }),
      ),
    ).toEqual({ signIn: true, openSettings: false, refresh: false, diagnostics: false });
  });

  it("offers only sign-in when the chat capability is unavailable", () => {
    expect(
      resolveProviderStatusNoticeActions(
        makeProvider({
          status: "warning",
          auth: { status: "unknown", capabilities: { chat: { status: "unavailable" } } },
        }),
      ),
    ).toEqual({ signIn: true, openSettings: false, refresh: false, diagnostics: false });
  });

  it("sends a missing CLI to settings, with a refresh for an install that just landed", () => {
    expect(
      resolveProviderStatusNoticeActions(
        makeProvider({ installed: false, status: "error", auth: { status: "unauthenticated" } }),
      ),
    ).toEqual({ signIn: false, openSettings: true, refresh: true, diagnostics: false });
  });

  it("sends a disabled instance to settings and nowhere else", () => {
    expect(
      resolveProviderStatusNoticeActions(makeProvider({ enabled: false, status: "error" })),
    ).toEqual({ signIn: false, openSettings: true, refresh: false, diagnostics: false });
  });

  it("keeps refresh and diagnostics for probes and for anything it cannot name", () => {
    const probeTimeout = makeProvider({ statusReason: "provider_probe_timeout" });
    const cannotVerify = makeProvider({ status: "warning", auth: { status: "unknown" } });

    expect(resolveProviderStatusNoticeActions(probeTimeout)).toEqual({
      signIn: false,
      openSettings: false,
      refresh: true,
      diagnostics: true,
    });
    expect(resolveProviderStatusNoticeActions(cannotVerify)).toEqual({
      signIn: false,
      openSettings: false,
      refresh: true,
      diagnostics: true,
    });
  });
});
