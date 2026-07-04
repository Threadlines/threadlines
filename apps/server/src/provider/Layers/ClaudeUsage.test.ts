import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_OAUTH_TOKEN_ENV,
  CLAUDE_MACOS_KEYCHAIN_SERVICE,
  extractClaudeOAuthCredential,
  normalizeClaudeAccountUsage,
  normalizeClaudeScopedUsageWindow,
  normalizeClaudeUsageResetsAt,
  normalizeClaudeUsageWindow,
  parseClaudeUsageRetryAfter,
  readClaudeOAuthCredential,
} from "./ClaudeUsage.ts";

const encoder = new TextEncoder();

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
    });
  });

  it("returns undefined when the token is missing", () => {
    expect(extractClaudeOAuthCredential({ claudeAiOauth: { accessToken: " " } })).toBeUndefined();
    expect(extractClaudeOAuthCredential(undefined)).toBeUndefined();
  });
});

describe("readClaudeOAuthCredential", () => {
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
          return yield* readClaudeOAuthCredential({ homePath }, { platform: "linux" });
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
      expect(credential).toBeUndefined();
    } finally {
      if (previousToken === undefined) {
        delete process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV];
      } else {
        process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV] = previousToken;
      }
    }
  });

  it("reads file-backed Claude credentials before consulting keychain", async () => {
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

        return yield* readClaudeOAuthCredential({ homePath }, { platform: "darwin" });
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

    expect(credential).toEqual({
      accessToken: "file-token",
      organizationUuid: "file-org",
      email: "file@example.com",
    });
  });

  it("falls back to the Claude Code keychain item on macOS", async () => {
    const credential = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "threadlines-claude-usage-",
        });
        return yield* readClaudeOAuthCredential({ homePath }, { platform: "darwin" });
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
      accessToken: "keychain-token",
      organizationUuid: "keychain-org",
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
        return yield* readClaudeOAuthCredential({ homePath }, { platform: "darwin" });
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
      accessToken: "service-token",
      organizationUuid: "service-org",
    });
  });

  it("does not query keychain on non-macOS platforms", async () => {
    const credential = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "threadlines-claude-usage-",
        });
        return yield* readClaudeOAuthCredential({ homePath }, { platform: "linux" });
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

    expect(credential).toBeUndefined();
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
          },
          secondary: {
            usedPercent: 69,
            remainingPercent: 31,
            resetsAt: Date.parse("2026-06-10T20:48:00.000Z"),
            windowDurationMins: 10_080,
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
          },
          secondary: {
            usedPercent: 9,
            remainingPercent: 91,
            resetsAt: Date.parse("2026-06-12T03:00:00.000Z"),
            windowDurationMins: 10_080,
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
          },
          secondary: {
            usedPercent: 39,
            remainingPercent: 61,
            resetsAt: Date.parse("2026-07-10T03:00:00.000Z"),
            windowDurationMins: 10_080,
          },
          scoped: [
            {
              scopeLabel: "Fable",
              usedPercent: 78,
              remainingPercent: 22,
              resetsAt: Date.parse("2026-07-10T03:00:00.000Z"),
              windowDurationMins: 10_080,
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
