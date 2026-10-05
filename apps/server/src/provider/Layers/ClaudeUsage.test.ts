import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vite-plus/test";

import {
  applyClaudeRateLimitInfoToAccountUsage,
  CLAUDE_CODE_OAUTH_TOKEN_ENV,
  CLAUDE_MACOS_KEYCHAIN_SERVICE,
  claudeUsageBackoffKey,
  extractClaudeOAuthCredential,
  fetchClaudeAccountUsage,
  normalizeClaudeAccountUsage,
  normalizeClaudeScopedUsageWindow,
  normalizeClaudeUsageResetsAt,
  normalizeClaudeUsageWindow,
  parseClaudeUsageRetryAfter,
  carryClaudeAccountUsageForward,
  claudeKeychainServiceName,
  isClaudeSignInRenewalDue,
  preferNewerClaudeUsageReadings,
  readClaudeStoredSignIn,
} from "./ClaudeUsage.ts";

const encoder = new TextEncoder();

describe("claudeUsageBackoffKey", () => {
  it("isolates Retry-After state when a fresh login rotates the credential", () => {
    const previous = claudeUsageBackoffKey({ accessToken: "expired-token" });
    const refreshed = claudeUsageBackoffKey({ accessToken: "refreshed-token" });

    expect(previous).not.toBe(refreshed);
    expect(previous).not.toContain("expired-token");
    expect(refreshed).not.toContain("refreshed-token");
  });
});

function mockHandle(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly code?: number;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { readonly args: ReadonlyArray<string> };
      const args = Array.isArray(cmd.args) ? cmd.args : [];
      return Effect.succeed(mockHandle(handler(args)));
    }),
  );
}

describe("normalizeClaudeUsageResetsAt", () => {
  it("parses ISO 8601 strings to epoch milliseconds", () => {
    expect(normalizeClaudeUsageResetsAt("2026-06-10T12:00:00.000Z")).toBe(
      Date.parse("2026-06-10T12:00:00.000Z"),
    );
  });

  it("passes finite positive numbers through rounded", () => {
    expect(normalizeClaudeUsageResetsAt(1_781_179_200.4)).toBe(1_781_179_200);
  });

  it("returns undefined for null, missing, and unparseable values", () => {
    expect(normalizeClaudeUsageResetsAt(null)).toBeUndefined();
    expect(normalizeClaudeUsageResetsAt(undefined)).toBeUndefined();
    expect(normalizeClaudeUsageResetsAt("not-a-date")).toBeUndefined();
    expect(normalizeClaudeUsageResetsAt(0)).toBeUndefined();
    expect(normalizeClaudeUsageResetsAt(-5)).toBeUndefined();
  });
});

describe("extractClaudeOAuthCredential", () => {
  it("uses the access token even when expiresAt is stale", () => {
    expect(
      extractClaudeOAuthCredential({
        claudeAiOauth: {
          accessToken: " token ",
          expiresAt: 1,
        },
        account: {
          email: " claude@example.com ",
        },
        organizationUuid: " org-1 ",
      }),
    ).toEqual({
      accessToken: "token",
      organizationUuid: "org-1",
      email: "claude@example.com",
      expiresAt: 1,
      renewable: false,
    });
  });

  it("extracts email from nested Claude OAuth credential metadata", () => {
    expect(
      extractClaudeOAuthCredential({
        claudeAiOauth: {
          accessToken: "token",
          account: {
            email: "nested@example.com",
          },
        },
      }),
    ).toEqual({
      accessToken: "token",
      email: "nested@example.com",
      renewable: false,
    });
  });

  it("returns undefined when the token is missing", () => {
    expect(extractClaudeOAuthCredential({ claudeAiOauth: { accessToken: " " } })).toBeUndefined();
    expect(extractClaudeOAuthCredential(undefined)).toBeUndefined();
  });
});

describe("readClaudeStoredSignIn", () => {
  it("does not use the provider long-lived OAuth token for usage credentials", async () => {
    const previousToken = process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV];
    process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV] = "env-token";
    try {
      const credential = await Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const homePath = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "threadlines-claude-usage-",
          });
          return yield* readClaudeStoredSignIn(
            { homePath, accountFolder: "" },
            { platform: "linux" },
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              mockSpawnerLayer(() => {
                throw new Error("keychain should not be queried");
              }),
            ),
          ),
        ),
      );
      expect(credential).toEqual({ _tag: "Absent" });
    } finally {
      if (previousToken === undefined) {
        delete process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV];
      } else {
        process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV] = previousToken;
      }
    }
  });

  it("reads the config folder's file when the keychain has no item", async () => {
    const credential = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "threadlines-claude-usage-",
        });
        yield* fileSystem.makeDirectory(path.join(homePath, ".claude"));
        yield* fileSystem.writeFileString(
          path.join(homePath, ".claude", ".credentials.json"),
          '{"claudeAiOauth":{"accessToken":"file-token","expiresAt":1},"account":{"email":"file@example.com"},"organizationUuid":"file-org"}',
        );

        return yield* readClaudeStoredSignIn(
          { homePath, accountFolder: "" },
          { platform: "darwin" },
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            // Like the CLI, the keychain is asked first; it has nothing here.
            mockSpawnerLayer(() => ({ code: 44 })),
          ),
        ),
      ),
    );

    expect(credential).toEqual({
      _tag: "Present",
      credential: {
        accessToken: "file-token",
        organizationUuid: "file-org",
        email: "file@example.com",
        expiresAt: 1,
        renewable: false,
      },
    });
  });

  it("reads the Claude Code keychain item on macOS", async () => {
    const credential = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "threadlines-claude-usage-",
        });
        return yield* readClaudeStoredSignIn(
          { homePath, accountFolder: "" },
          { platform: "darwin" },
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            mockSpawnerLayer((args) => {
              expect(args).toEqual([
                "find-generic-password",
                "-a",
                expect.any(String),
                "-w",
                "-s",
                CLAUDE_MACOS_KEYCHAIN_SERVICE,
              ]);
              return {
                stdout:
                  '{"claudeAiOauth":{"accessToken":"keychain-token","expiresAt":1},"organizationUuid":"keychain-org"}',
              };
            }),
          ),
        ),
      ),
    );

    expect(credential).toEqual({
      _tag: "Present",
      credential: {
        accessToken: "keychain-token",
        organizationUuid: "keychain-org",
        expiresAt: 1,
        renewable: false,
      },
    });
  });

  it("retries the macOS keychain lookup without account scoping", async () => {
    const seenArgs: Array<ReadonlyArray<string>> = [];
    const credential = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "threadlines-claude-usage-",
        });
        return yield* readClaudeStoredSignIn(
          { homePath, accountFolder: "" },
          { platform: "darwin" },
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            mockSpawnerLayer((args) => {
              seenArgs.push(args);
              if (seenArgs.length === 1) return { code: 44 };
              return {
                stdout:
                  '{"claudeAiOauth":{"accessToken":"service-token"},"organizationUuid":"service-org"}',
              };
            }),
          ),
        ),
      ),
    );

    expect(seenArgs).toEqual([
      [
        "find-generic-password",
        "-a",
        expect.any(String),
        "-w",
        "-s",
        CLAUDE_MACOS_KEYCHAIN_SERVICE,
      ],
      ["find-generic-password", "-w", "-s", CLAUDE_MACOS_KEYCHAIN_SERVICE],
    ]);
    expect(credential).toEqual({
      _tag: "Present",
      credential: {
        accessToken: "service-token",
        organizationUuid: "service-org",
        renewable: false,
      },
    });
  });

  it("does not query keychain on non-macOS platforms", async () => {
    const credential = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "threadlines-claude-usage-",
        });
        return yield* readClaudeStoredSignIn(
          { homePath, accountFolder: "" },
          { platform: "linux" },
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            mockSpawnerLayer(() => {
              throw new Error("keychain should not be queried");
            }),
          ),
        ),
      ),
    );

    expect(credential).toEqual({ _tag: "Absent" });
  });
});

describe("parseClaudeUsageRetryAfter", () => {
  it("parses delta seconds as an absolute retry timestamp", () => {
    expect(parseClaudeUsageRetryAfter("45", 1_000)).toBe(46_000);
  });

  it("parses HTTP dates and caps excessive retry windows", () => {
    const nowMs = Date.parse("2026-06-10T00:00:00.000Z");
    expect(parseClaudeUsageRetryAfter("Wed, 10 Jun 2026 00:02:00 GMT", nowMs)).toBe(
      Date.parse("2026-06-10T00:02:00.000Z"),
    );
    expect(parseClaudeUsageRetryAfter("7200", nowMs)).toBe(nowMs + 60 * 60 * 1000);
  });

  it("ignores missing, invalid, and past values", () => {
    const nowMs = Date.parse("2026-06-10T00:00:00.000Z");
    expect(parseClaudeUsageRetryAfter(undefined, nowMs)).toBeUndefined();
    expect(parseClaudeUsageRetryAfter("nope", nowMs)).toBeUndefined();
    expect(parseClaudeUsageRetryAfter("0", nowMs)).toBeUndefined();
    expect(parseClaudeUsageRetryAfter("Wed, 09 Jun 2026 00:00:00 GMT", nowMs)).toBeUndefined();
  });
});

describe("normalizeClaudeUsageWindow", () => {
  it("rounds and clamps utilization and derives remaining percent", () => {
    expect(
      normalizeClaudeUsageWindow({ utilization: 30.6, resets_at: "2026-06-10T12:00:00.000Z" }, 300),
    ).toEqual({
      usedPercent: 31,
      remainingPercent: 69,
      resetsAt: Date.parse("2026-06-10T12:00:00.000Z"),
      windowDurationMins: 300,
    });
  });

  it("clamps utilization above 100", () => {
    expect(normalizeClaudeUsageWindow({ utilization: 130 }, 300)).toEqual({
      usedPercent: 100,
      remainingPercent: 0,
      windowDurationMins: 300,
    });
  });

  it("returns undefined when utilization is missing", () => {
    expect(normalizeClaudeUsageWindow(undefined, 300)).toBeUndefined();
    expect(normalizeClaudeUsageWindow(null, 300)).toBeUndefined();
    expect(
      normalizeClaudeUsageWindow({ resets_at: "2026-06-10T12:00:00.000Z" }, 300),
    ).toBeUndefined();
    expect(normalizeClaudeUsageWindow({ utilization: null }, 300)).toBeUndefined();
  });
});

describe("normalizeClaudeScopedUsageWindow", () => {
  it("maps model-scoped weekly limits with severity", () => {
    expect(
      normalizeClaudeScopedUsageWindow({
        kind: "weekly_scoped",
        group: "weekly",
        percent: 78.4,
        severity: "warning",
        resets_at: "2026-07-10T03:00:00.000Z",
        scope: { model: { display_name: "Fable" }, surface: null },
      }),
    ).toEqual({
      scopeLabel: "Fable",
      usedPercent: 78,
      remainingPercent: 22,
      resetsAt: Date.parse("2026-07-10T03:00:00.000Z"),
      windowDurationMins: 10_080,
      severity: "warning",
    });
  });

  it("falls back to the surface scope label", () => {
    expect(
      normalizeClaudeScopedUsageWindow({
        group: "weekly",
        percent: 12,
        scope: { model: null, surface: "cowork" },
      }),
    ).toEqual({
      scopeLabel: "cowork",
      usedPercent: 12,
      remainingPercent: 88,
      windowDurationMins: 10_080,
    });
  });

  it("skips unscoped entries and entries missing a percent or scope label", () => {
    expect(
      normalizeClaudeScopedUsageWindow({
        kind: "session",
        group: "session",
        percent: 35,
        scope: null,
      }),
    ).toBeUndefined();
    expect(
      normalizeClaudeScopedUsageWindow({
        kind: "weekly_scoped",
        group: "weekly",
        scope: { model: { display_name: "Fable" } },
      }),
    ).toBeUndefined();
    expect(
      normalizeClaudeScopedUsageWindow({
        kind: "weekly_scoped",
        group: "weekly",
        percent: 10,
        scope: { model: { display_name: "  " }, surface: null },
      }),
    ).toBeUndefined();
  });
});

describe("normalizeClaudeAccountUsage", () => {
  const checkedAt = "2026-06-10T00:00:00.000Z";

  it("maps five_hour and seven_day windows onto one claude limit", () => {
    expect(
      normalizeClaudeAccountUsage(
        {
          five_hour: { utilization: 31, resets_at: "2026-06-10T02:32:00.000Z" },
          seven_day: { utilization: 69, resets_at: "2026-06-10T20:48:00.000Z" },
        },
        checkedAt,
      ),
    ).toEqual({
      source: "claude-oauth-usage",
      checkedAt,
      primaryLimitId: "claude",
      limits: [
        {
          limitId: "claude",
          primary: {
            usedPercent: 31,
            remainingPercent: 69,
            resetsAt: Date.parse("2026-06-10T02:32:00.000Z"),
            windowDurationMins: 300,
            checkedAt,
          },
          secondary: {
            usedPercent: 69,
            remainingPercent: 31,
            resetsAt: Date.parse("2026-06-10T20:48:00.000Z"),
            windowDurationMins: 10_080,
            checkedAt,
          },
        },
      ],
    });
  });

  it("keeps the weekly window when the 5h window is absent", () => {
    expect(
      normalizeClaudeAccountUsage(
        {
          five_hour: null,
          seven_day: { utilization: 12 },
        },
        checkedAt,
      ),
    ).toEqual({
      source: "claude-oauth-usage",
      checkedAt,
      primaryLimitId: "claude",
      limits: [
        {
          limitId: "claude",
          secondary: {
            usedPercent: 12,
            remainingPercent: 88,
            windowDurationMins: 10_080,
            checkedAt,
          },
        },
      ],
    });
  });

  it("maps capped endpoint payloads that include unrelated Claude windows", () => {
    expect(
      normalizeClaudeAccountUsage(
        {
          five_hour: { utilization: 100, resets_at: "2026-06-10T18:30:00.000Z" },
          seven_day: { utilization: 9, resets_at: "2026-06-12T03:00:00.000Z" },
          seven_day_sonnet: { utilization: 0, resets_at: "2026-06-12T03:00:00.000Z" },
          extra_usage: {
            is_enabled: true,
            monthly_limit: null,
            used_credits: 9202,
          },
        } as unknown as Parameters<typeof normalizeClaudeAccountUsage>[0],
        checkedAt,
      ),
    ).toEqual({
      source: "claude-oauth-usage",
      checkedAt,
      primaryLimitId: "claude",
      limits: [
        {
          limitId: "claude",
          primary: {
            usedPercent: 100,
            remainingPercent: 0,
            resetsAt: Date.parse("2026-06-10T18:30:00.000Z"),
            windowDurationMins: 300,
            checkedAt,
          },
          secondary: {
            usedPercent: 9,
            remainingPercent: 91,
            resetsAt: Date.parse("2026-06-12T03:00:00.000Z"),
            windowDurationMins: 10_080,
            checkedAt,
          },
        },
      ],
    });
  });

  it("appends scoped limits from the generic limits array", () => {
    expect(
      normalizeClaudeAccountUsage(
        {
          five_hour: { utilization: 35, resets_at: "2026-07-04T05:30:00.000Z" },
          seven_day: { utilization: 39, resets_at: "2026-07-10T03:00:00.000Z" },
          limits: [
            {
              kind: "session",
              group: "session",
              percent: 35,
              severity: "normal",
              resets_at: "2026-07-04T05:30:00.000Z",
              scope: null,
            },
            {
              kind: "weekly_all",
              group: "weekly",
              percent: 39,
              severity: "normal",
              resets_at: "2026-07-10T03:00:00.000Z",
              scope: null,
            },
            {
              kind: "weekly_scoped",
              group: "weekly",
              percent: 78,
              severity: "warning",
              resets_at: "2026-07-10T03:00:00.000Z",
              scope: { model: { display_name: "Fable" }, surface: null },
            },
          ],
        },
        checkedAt,
      ),
    ).toEqual({
      source: "claude-oauth-usage",
      checkedAt,
      primaryLimitId: "claude",
      limits: [
        {
          limitId: "claude",
          primary: {
            usedPercent: 35,
            remainingPercent: 65,
            resetsAt: Date.parse("2026-07-04T05:30:00.000Z"),
            windowDurationMins: 300,
            checkedAt,
          },
          secondary: {
            usedPercent: 39,
            remainingPercent: 61,
            resetsAt: Date.parse("2026-07-10T03:00:00.000Z"),
            windowDurationMins: 10_080,
            checkedAt,
          },
          scoped: [
            {
              scopeLabel: "Fable",
              usedPercent: 78,
              remainingPercent: 22,
              resetsAt: Date.parse("2026-07-10T03:00:00.000Z"),
              windowDurationMins: 10_080,
              checkedAt,
              severity: "warning",
            },
          ],
        },
      ],
    });
  });

  it("keeps scoped limits when the top-level windows are absent", () => {
    expect(
      normalizeClaudeAccountUsage(
        {
          five_hour: null,
          seven_day: null,
          limits: [
            {
              kind: "weekly_scoped",
              group: "weekly",
              percent: 78,
              scope: { model: { display_name: "Fable" }, surface: null },
            },
          ],
        },
        checkedAt,
      ),
    ).toEqual({
      source: "claude-oauth-usage",
      checkedAt,
      primaryLimitId: "claude",
      limits: [
        {
          limitId: "claude",
          scoped: [
            {
              scopeLabel: "Fable",
              usedPercent: 78,
              remainingPercent: 22,
              windowDurationMins: 10_080,
              checkedAt,
            },
          ],
        },
      ],
    });
  });

  it("returns undefined when no window carries utilization data", () => {
    expect(normalizeClaudeAccountUsage({}, checkedAt)).toBeUndefined();
    expect(
      normalizeClaudeAccountUsage({ five_hour: null, seven_day: null }, checkedAt),
    ).toBeUndefined();
    expect(
      normalizeClaudeAccountUsage({ five_hour: null, seven_day: null, limits: [] }, checkedAt),
    ).toBeUndefined();
  });
});

describe("applyClaudeRateLimitInfoToAccountUsage", () => {
  const checkedAt = "2026-07-09T00:00:00.000Z";
  const baseUsage = normalizeClaudeAccountUsage(
    {
      five_hour: { utilization: 31, resets_at: "2026-07-09T02:32:00.000Z" },
      seven_day: { utilization: 69, resets_at: "2026-07-10T20:48:00.000Z" },
      limits: [
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 40,
          resets_at: "2026-07-10T03:00:00.000Z",
          scope: { model: { display_name: "Opus" }, surface: null },
        },
      ],
    },
    "2026-07-08T23:00:00.000Z",
  )!;

  it("creates a fresh snapshot from a five_hour event when no usage exists", () => {
    expect(
      applyClaudeRateLimitInfoToAccountUsage(
        undefined,
        { rateLimitType: "five_hour", utilization: 0.424, resetsAt: 1_783_000_000 },
        checkedAt,
      ),
    ).toEqual({
      source: "claude-oauth-usage",
      checkedAt,
      primaryLimitId: "claude",
      limits: [
        {
          limitId: "claude",
          primary: {
            usedPercent: 42,
            remainingPercent: 58,
            resetsAt: 1_783_000_000,
            windowDurationMins: 300,
            checkedAt,
          },
        },
      ],
    });
  });

  it("patches the 5h window and preserves the weekly and scoped windows", () => {
    const next = applyClaudeRateLimitInfoToAccountUsage(
      baseUsage,
      { rateLimitType: "five_hour", utilization: 0.55, resetsAt: 1_783_111_111 },
      checkedAt,
    );
    expect(next).toEqual({
      ...baseUsage,
      checkedAt,
      limits: [
        {
          ...baseUsage.limits[0]!,
          primary: {
            usedPercent: 55,
            remainingPercent: 45,
            resetsAt: 1_783_111_111,
            windowDurationMins: 300,
            checkedAt,
          },
        },
      ],
    });
    expect(next?.limits[0]?.secondary).toEqual(baseUsage.limits[0]?.secondary);
    expect(next?.limits[0]?.scoped).toEqual(baseUsage.limits[0]?.scoped);
  });

  it("reads the event's 0-1 utilization as a percent when patching the weekly window", () => {
    const next = applyClaudeRateLimitInfoToAccountUsage(
      baseUsage,
      { rateLimitType: "seven_day", utilization: 0.79 },
      checkedAt,
    );
    expect(next?.limits[0]?.secondary).toEqual({
      usedPercent: 79,
      remainingPercent: 21,
      windowDurationMins: 10_080,
      checkedAt,
    });
    expect(next?.limits[0]?.primary).toEqual(baseUsage.limits[0]?.primary);
  });

  it("patches every window in unifiedWindows, even below the warning threshold", () => {
    const next = applyClaudeRateLimitInfoToAccountUsage(
      baseUsage,
      {
        rateLimitType: "five_hour",
        resetsAt: 1_783_111_111,
        unifiedWindows: {
          five_hour: { utilization: 0.13, resetsAt: 1_783_111_111 },
          seven_day: { utilization: 0.72, resetsAt: 1_783_222_222 },
          seven_day_overage_included: { utilization: 0.9, resetsAt: 1_783_222_222 },
        },
      },
      checkedAt,
    );
    expect(next).toEqual({
      ...baseUsage,
      checkedAt,
      limits: [
        {
          ...baseUsage.limits[0]!,
          primary: {
            usedPercent: 13,
            remainingPercent: 87,
            resetsAt: 1_783_111_111,
            windowDurationMins: 300,
            checkedAt,
          },
          secondary: {
            usedPercent: 72,
            remainingPercent: 28,
            resetsAt: 1_783_222_222,
            windowDurationMins: 10_080,
            checkedAt,
          },
        },
      ],
    });
  });

  it("patches a matching scoped window from a per-model event", () => {
    const next = applyClaudeRateLimitInfoToAccountUsage(
      baseUsage,
      { rateLimitType: "seven_day_opus", utilization: 0.62, resetsAt: 1_783_222_222 },
      checkedAt,
    );
    expect(next?.limits[0]?.scoped).toEqual([
      {
        scopeLabel: "Opus",
        usedPercent: 62,
        remainingPercent: 38,
        resetsAt: 1_783_222_222,
        windowDurationMins: 10_080,
        checkedAt,
      },
    ]);
    expect(next?.limits[0]?.primary).toEqual(baseUsage.limits[0]?.primary);
  });

  it("skips per-model events without a matching scoped window", () => {
    expect(
      applyClaudeRateLimitInfoToAccountUsage(
        baseUsage,
        { rateLimitType: "seven_day_sonnet", utilization: 0.62 },
        checkedAt,
      ),
    ).toBeUndefined();
    expect(
      applyClaudeRateLimitInfoToAccountUsage(
        undefined,
        { rateLimitType: "seven_day_opus", utilization: 0.62 },
        checkedAt,
      ),
    ).toBeUndefined();
  });

  it("skips unknown window types and events without utilization", () => {
    expect(
      applyClaudeRateLimitInfoToAccountUsage(
        baseUsage,
        { rateLimitType: "overage", utilization: 0.1 },
        checkedAt,
      ),
    ).toBeUndefined();
    expect(
      applyClaudeRateLimitInfoToAccountUsage(baseUsage, { rateLimitType: "five_hour" }, checkedAt),
    ).toBeUndefined();
    expect(applyClaudeRateLimitInfoToAccountUsage(baseUsage, {}, checkedAt)).toBeUndefined();
  });

  it("skips events that repeat a recent reading, and confirms an old one", () => {
    const sameReading = {
      rateLimitType: "five_hour",
      utilization: 0.31,
      resetsAt: Date.parse("2026-07-09T02:32:00.000Z"),
    };
    // Read at 23:00: a minute later there is nothing new to publish.
    expect(
      applyClaudeRateLimitInfoToAccountUsage(baseUsage, sameReading, "2026-07-08T23:01:00.000Z"),
    ).toBeUndefined();
    // An hour later the same numbers still say the reading is current.
    expect(
      applyClaudeRateLimitInfoToAccountUsage(baseUsage, sameReading, checkedAt)?.limits[0]?.primary
        ?.checkedAt,
    ).toBe(checkedAt);
  });
});

describe("fetchClaudeAccountUsage", () => {
  // Serves 401 for any token except `freshToken`, which gets a usage payload.
  // Records the bearer of every request so tests can assert the retry order.
  function usageEndpointLayer(freshToken: string, bearers: Array<string | undefined>) {
    return Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const authorization = (request.headers as unknown as Record<string, string>).authorization;
        bearers.push(authorization);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            authorization === `Bearer ${freshToken}`
              ? new Response(JSON.stringify({ five_hour: { utilization: 18 } }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                })
              : new Response(JSON.stringify({ error: { type: "authentication_error" } }), {
                  status: 401,
                  headers: { "content-type": "application/json" },
                }),
          ),
        );
      }),
    );
  }

  function credentialsJson(accessToken: string, refreshToken: string | null = "refresh"): string {
    return JSON.stringify({ claudeAiOauth: { accessToken, refreshToken } });
  }

  // An empty keychain (`security` exit 44): the login is read from the file.
  const noKeychainLayer = () => mockSpawnerLayer(() => ({ code: 44 }));

  it("renews an expired credential and retries the usage fetch once", async () => {
    const bearers: Array<string | undefined> = [];
    let refreshRuns = 0;
    const usage = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "threadlines-claude-usage-",
        });
        const credentialsPath = path.join(homePath, ".claude", ".credentials.json");
        yield* fileSystem.makeDirectory(path.join(homePath, ".claude"));
        yield* fileSystem.writeFileString(credentialsPath, credentialsJson("renew-stale-token"));
        const refresh = Effect.gen(function* () {
          refreshRuns += 1;
          yield* fileSystem.writeFileString(credentialsPath, credentialsJson("renew-fresh-token"));
          return true;
        }).pipe(Effect.orDie);
        return yield* fetchClaudeAccountUsage({ homePath, accountFolder: "" }, {}, refresh);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            noKeychainLayer(),
            usageEndpointLayer("renew-fresh-token", bearers),
          ),
        ),
      ),
    );

    expect(refreshRuns).toBe(1);
    expect(bearers).toEqual(["Bearer renew-stale-token", "Bearer renew-fresh-token"]);
    expect(usage._tag === "Fresh" ? usage.usage.limits[0]?.primary?.usedPercent : usage).toBe(18);
  });

  it("cools down after a refresh that does not rotate the credential", async () => {
    const bearers: Array<string | undefined> = [];
    let refreshRuns = 0;
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "threadlines-claude-usage-",
        });
        yield* fileSystem.makeDirectory(path.join(homePath, ".claude"));
        yield* fileSystem.writeFileString(
          path.join(homePath, ".claude", ".credentials.json"),
          credentialsJson("cooldown-stale-token"),
        );
        // A dead sign-in: the refresh "succeeds" but the store keeps the
        // same token, so no retry fires and the next 401 must not spawn
        // another refresh attempt while the cooldown holds.
        const refresh = Effect.sync(() => {
          refreshRuns += 1;
          return true;
        });
        const first = yield* fetchClaudeAccountUsage({ homePath, accountFolder: "" }, {}, refresh);
        const second = yield* fetchClaudeAccountUsage({ homePath, accountFolder: "" }, {}, refresh);
        return [first, second];
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, noKeychainLayer(), usageEndpointLayer("", bearers)),
        ),
      ),
    );

    const unreachable = { _tag: "Unavailable", reason: "unreachable" };
    expect(results).toEqual([unreachable, unreachable]);
    expect(refreshRuns).toBe(1);
    expect(bearers).toEqual(["Bearer cooldown-stale-token", "Bearer cooldown-stale-token"]);
  });

  it("does not retry when the refresh turn fails", async () => {
    const bearers: Array<string | undefined> = [];
    const usage = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "threadlines-claude-usage-",
        });
        yield* fileSystem.makeDirectory(path.join(homePath, ".claude"));
        yield* fileSystem.writeFileString(
          path.join(homePath, ".claude", ".credentials.json"),
          credentialsJson("failed-refresh-token"),
        );
        return yield* fetchClaudeAccountUsage(
          { homePath, accountFolder: "" },
          {},
          Effect.succeed(false),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, noKeychainLayer(), usageEndpointLayer("", bearers)),
        ),
      ),
    );

    expect(usage).toEqual({ _tag: "Unavailable", reason: "unreachable" });
    expect(bearers).toEqual(["Bearer failed-refresh-token"]);
  });

  it("uses a sign-in another process renewed instead of renewing it again", async () => {
    const bearers: Array<string | undefined> = [];
    const usage = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "threadlines-claude-usage-",
        });
        const credentialsPath = path.join(homePath, ".claude", ".credentials.json");
        yield* fileSystem.makeDirectory(path.join(homePath, ".claude"));
        yield* fileSystem.writeFileString(credentialsPath, credentialsJson("raced-stale-token"));
        // A Claude session elsewhere renews while the first request is out.
        const renewedElsewhere = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const authorization = (request.headers as unknown as Record<string, string>)
              .authorization;
            bearers.push(authorization);
            const fresh = authorization === "Bearer raced-fresh-token";
            return (
              fresh
                ? Effect.void
                : fileSystem
                    .writeFileString(credentialsPath, credentialsJson("raced-fresh-token"))
                    .pipe(Effect.orDie)
            ).pipe(
              Effect.as(
                HttpClientResponse.fromWeb(
                  request,
                  fresh
                    ? new Response(JSON.stringify({ five_hour: { utilization: 7 } }), {
                        status: 200,
                        headers: { "content-type": "application/json" },
                      })
                    : new Response("{}", { status: 401 }),
                ),
              ),
            );
          }),
        );
        return yield* fetchClaudeAccountUsage(
          { homePath, accountFolder: "" },
          {},
          Effect.die("A sign-in that was already renewed must not be renewed again"),
        ).pipe(Effect.provide(renewedElsewhere));
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, noKeychainLayer()))),
    );

    expect(bearers).toEqual(["Bearer raced-stale-token", "Bearer raced-fresh-token"]);
    expect(usage._tag === "Fresh" ? usage.usage.limits[0]?.primary?.usedPercent : usage).toBe(7);
  });

  it("says signed out only when the sign-in is gone or can never renew", async () => {
    const bearers: Array<string | undefined> = [];
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "threadlines-claude-usage-",
        });
        const credentialsPath = path.join(homePath, ".claude", ".credentials.json");
        yield* fileSystem.makeDirectory(path.join(homePath, ".claude"));
        const check = (refresh: Effect.Effect<boolean>) =>
          fetchClaudeAccountUsage({ homePath, accountFolder: "" }, {}, refresh);

        // Nothing stored: no request is even made.
        const nothingStored = yield* check(Effect.succeed(true));
        // The CLI removes a sign-in whose renewal the server refused.
        yield* fileSystem.writeFileString(credentialsPath, credentialsJson("refused-token"));
        const removedByRenewal = yield* check(
          fileSystem.remove(credentialsPath).pipe(Effect.as(false), Effect.orDie),
        );
        // Rejected, with no refresh token left to renew it.
        yield* fileSystem.writeFileString(credentialsPath, credentialsJson("spent-token", null));
        const cannotRenew = yield* check(Effect.succeed(false));
        return [nothingStored, removedByRenewal, cannotRenew];
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, noKeychainLayer(), usageEndpointLayer("", bearers)),
        ),
      ),
    );

    const signedOut = { _tag: "Unavailable", reason: "signed_out" };
    expect(results).toEqual([signedOut, signedOut, signedOut]);
    expect(bearers).toEqual(["Bearer refused-token", "Bearer spent-token"]);
  });

  it("treats a rate limit and a failed request as temporary, without renewing", async () => {
    const check = (token: string, status: number) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const homePath = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "threadlines-claude-usage-",
          });
          yield* fileSystem.makeDirectory(path.join(homePath, ".claude"));
          yield* fileSystem.writeFileString(
            path.join(homePath, ".claude", ".credentials.json"),
            credentialsJson(token),
          );
          return yield* fetchClaudeAccountUsage(
            { homePath, accountFolder: "" },
            {},
            Effect.die("A temporary failure must not start a renewal"),
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              noKeychainLayer(),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) =>
                  Effect.succeed(
                    HttpClientResponse.fromWeb(request, new Response("{}", { status })),
                  ),
                ),
              ),
            ),
          ),
        ),
      );

    expect(await check("rate-limited-token", 429)).toEqual({
      _tag: "Unavailable",
      reason: "rate_limited",
    });
    expect(await check("server-error-token", 503)).toEqual({
      _tag: "Unavailable",
      reason: "unreachable",
    });
  });
});

describe("carryClaudeAccountUsageForward", () => {
  it("starts a window over once its reset time has passed and keeps the rest as read", () => {
    const readAt = "2026-07-09T00:00:00.000Z";
    const usage = normalizeClaudeAccountUsage(
      {
        five_hour: { utilization: 80, resets_at: "2026-07-09T02:00:00.000Z" },
        seven_day: { utilization: 40, resets_at: "2026-07-12T00:00:00.000Z" },
        limits: [
          {
            group: "weekly",
            percent: 90,
            severity: "warning",
            resets_at: "2026-07-09T01:00:00.000Z",
            scope: { model: { display_name: "Fable" }, surface: null },
          },
        ],
      },
      readAt,
    )!;

    const carried = carryClaudeAccountUsageForward(usage, Date.parse("2026-07-09T03:00:00.000Z"));

    expect(carried?.limits[0]).toEqual({
      limitId: "claude",
      // The 5h window ended an hour ago: nothing used yet, next reset unknown.
      primary: {
        usedPercent: 0,
        remainingPercent: 100,
        windowDurationMins: 300,
        checkedAt: readAt,
      },
      secondary: usage.limits[0]?.secondary,
      scoped: [
        {
          scopeLabel: "Fable",
          usedPercent: 0,
          remainingPercent: 100,
          windowDurationMins: 10_080,
          checkedAt: readAt,
        },
      ],
    });
    // An event's reset time is in seconds; it rolls over the same way.
    const fromEvent = applyClaudeRateLimitInfoToAccountUsage(
      undefined,
      { rateLimitType: "five_hour", utilization: 0.5, resetsAt: Date.parse(readAt) / 1000 + 60 },
      readAt,
    );
    expect(
      carryClaudeAccountUsageForward(fromEvent, Date.parse(readAt) + 120_000)?.limits[0]?.primary
        ?.usedPercent,
    ).toBe(0);
    expect(carryClaudeAccountUsageForward(undefined, 0)).toBeUndefined();
  });

  it("dates a reading saved before windows recorded their own time", () => {
    const savedAt = "2026-07-09T00:00:00.000Z";
    const carried = carryClaudeAccountUsageForward(
      {
        source: "claude-oauth-usage",
        checkedAt: savedAt,
        limits: [{ limitId: "claude", primary: { usedPercent: 12, remainingPercent: 88 } }],
      },
      Date.parse("2026-07-09T05:00:00.000Z"),
    );

    // Without this it would be shown as a current reading for as long as checks fail.
    expect(carried?.limits[0]?.primary?.checkedAt).toBe(savedAt);
  });
});

describe("preferNewerClaudeUsageReadings", () => {
  it("keeps a reading a chat reply published while the check was running", () => {
    const checkRead = normalizeClaudeAccountUsage(
      {
        five_hour: { utilization: 10 },
        seven_day: { utilization: 40 },
      },
      "2026-07-09T00:00:00.000Z",
    )!;
    // The reply landed two seconds after the check read the endpoint.
    const afterReply = applyClaudeRateLimitInfoToAccountUsage(
      checkRead,
      { rateLimitType: "five_hour", utilization: 0.2 },
      "2026-07-09T00:00:02.000Z",
    )!;

    const published = preferNewerClaudeUsageReadings(afterReply, checkRead);

    expect(published?.limits[0]?.primary?.usedPercent).toBe(20);
    expect(published?.limits[0]?.secondary).toEqual(checkRead.limits[0]?.secondary);
    // Nothing newer than the check: its reading stands untouched.
    expect(preferNewerClaudeUsageReadings(checkRead, checkRead)).toBe(checkRead);
    expect(preferNewerClaudeUsageReadings(undefined, checkRead)).toBe(checkRead);
  });
});

describe("isClaudeSignInRenewalDue", () => {
  const nowMs = Date.parse("2026-07-09T00:00:00.000Z");
  const present = (expiresInMs: number | undefined, renewable = true) =>
    ({
      _tag: "Present",
      credential: {
        accessToken: "token",
        renewable,
        ...(expiresInMs === undefined ? {} : { expiresAt: nowMs + expiresInMs }),
      },
    }) as const;
  const due = (
    stored: Parameters<typeof isClaudeSignInRenewalDue>[0]["stored"],
    environment: NodeJS.ProcessEnv = {},
  ) => isClaudeSignInRenewalDue({ stored, environment, nowMs });

  it("is due once a starting CLI would renew the stored sign-in", () => {
    expect(due(present(-60_000))).toBe(true);
    expect(due(present(4 * 60_000))).toBe(true);
    expect(due(present(2 * 60 * 60_000))).toBe(false);
    // Nothing the CLI could renew, or would: no expiry, no refresh token, no sign-in.
    expect(due(present(undefined))).toBe(false);
    expect(due(present(-60_000, false))).toBe(false);
    expect(due({ _tag: "Absent" })).toBe(false);
    // A read that timed out proves nothing; one the keychain refused does.
    expect(due({ _tag: "Unreadable", transient: true })).toBe(true);
    expect(due({ _tag: "Unreadable", transient: false })).toBe(false);
  });

  it("only a chat-only token keeps the CLI off the stored sign-in", () => {
    expect(due(present(-60_000), { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" })).toBe(false);
    expect(due(present(-60_000), { ANTHROPIC_API_KEY: "sk-ant-api03-x" })).toBe(true);
  });
});

describe("Claude keychain item per account", () => {
  it("names the item the way Claude Code does for each config folder", () => {
    expect(claudeKeychainServiceName({})).toBe("Claude Code-credentials");
    expect(claudeKeychainServiceName({ CLAUDE_CONFIG_DIR: "/tmp/work" })).toBe(
      "Claude Code-credentials-f9be197a",
    );
    // Verbatim apart from NFC: a trailing slash is a different item.
    expect(claudeKeychainServiceName({ CLAUDE_CONFIG_DIR: "/tmp/work/" })).toBe(
      "Claude Code-credentials-1370e28d",
    );
    // The secure-storage override wins; set but empty, it is the default item.
    expect(
      claudeKeychainServiceName({
        CLAUDE_CONFIG_DIR: "/tmp/work",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
      }),
    ).toBe("Claude Code-credentials");
  });

  it("reads an account's own item and never falls back to the terminal's", async () => {
    const services: string[] = [];
    const credential = await Effect.runPromise(
      readClaudeStoredSignIn(
        { homePath: "", accountFolder: "/tmp/work" },
        {
          platform: "darwin",
          environment: { USER: "me", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" },
        },
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            mockSpawnerLayer((args) => {
              services.push(args[args.indexOf("-s") + 1] ?? "");
              return { code: 44 };
            }),
          ),
        ),
      ),
    );

    expect(credential).toEqual({ _tag: "Absent" });
    expect(new Set(services)).toEqual(new Set(["Claude Code-credentials-f9be197a"]));
  });
});
