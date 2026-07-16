import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerProvider } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });

  it("decodes separate usage auth email metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      version: "2.1.197",
      status: "ready",
      auth: {
        status: "authenticated",
        type: "longLivedOAuthToken",
        label: "Long-lived Claude token",
        usageEmail: "usage@example.com",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.auth.usageEmail).toBe("usage@example.com");
  });

  it("decodes capability-specific provider authentication health", () => {
    const parsed = decodeServerProvider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      version: "2.1.211",
      status: "ready",
      auth: {
        status: "authenticated",
        capabilities: {
          chat: {
            status: "configured",
            detail: "A credential was found locally.",
          },
          usage: {
            status: "verified",
            detail: "Usage was fetched successfully.",
          },
        },
      },
      checkedAt: "2026-07-15T00:00:00.000Z",
      models: [],
    });

    expect(parsed.auth.capabilities).toEqual({
      chat: {
        status: "configured",
        detail: "A credential was found locally.",
      },
      usage: {
        status: "verified",
        detail: "Usage was fetched successfully.",
      },
    });
  });

  it("decodes provider model descriptions", () => {
    const parsed = decodeServerProvider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      version: "2.1.170",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-06-09T00:00:00.000Z",
      models: [
        {
          slug: "claude-fable-5",
          name: "Claude Fable 5",
          description: "Included on subscriptions through Jun 22.",
          isCustom: false,
          capabilities: null,
        },
      ],
    });

    expect(parsed.models[0]?.description).toBe("Included on subscriptions through Jun 22.");
  });

  it("decodes account usage snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      accountUsage: {
        source: "codex-rate-limits",
        checkedAt: "2026-04-10T00:00:00.000Z",
        primaryLimitId: "codex",
        rateLimitResetCredits: {
          availableCount: 1,
          credits: [
            {
              id: "reset-1",
              resetType: "codexRateLimits",
              status: "available",
              grantedAt: 1_776_297_600,
              expiresAt: 1_778_889_600,
              title: "Full reset",
              description: "Ready to redeem",
            },
          ],
        },
        tokenUsage: {
          checkedAt: "2026-04-10T00:00:00.000Z",
          dailyBuckets: [
            {
              startDate: "2026-04-09",
              tokens: 1200,
            },
          ],
          summary: {
            currentStreakDays: 3,
            lifetimeTokens: 1200000,
            peakDailyTokens: 500000,
          },
        },
        limits: [
          {
            limitId: "codex",
            limitName: "Codex",
            individualLimit: {
              limit: "$100.00",
              used: "$25.00",
              remainingPercent: 75,
              resetsAt: 1_800_086_400,
            },
            primary: {
              usedPercent: 25,
              remainingPercent: 75,
              resetsAt: 1_800_000_000,
              windowDurationMins: 300,
            },
          },
        ],
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.accountUsage?.limits[0]?.primary?.remainingPercent).toBe(75);
    expect(parsed.accountUsage?.limits[0]?.individualLimit?.remainingPercent).toBe(75);
    expect(parsed.accountUsage?.rateLimitResetCredits?.availableCount).toBe(1);
    expect(parsed.accountUsage?.rateLimitResetCredits?.credits?.[0]?.expiresAt).toBe(1_778_889_600);
    expect(parsed.accountUsage?.tokenUsage?.summary.lifetimeTokens).toBe(1200000);
    expect(parsed.accountUsage?.tokenUsage?.dailyBuckets[0]?.tokens).toBe(1200);
  });
});
