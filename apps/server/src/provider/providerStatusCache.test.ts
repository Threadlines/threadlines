import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";
import { createModelCapabilities } from "@threadlines/shared/model";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import {
  hydrateCachedProvider,
  isCachedProviderCorrelated,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "./providerStatusCache.ts";

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");

const makeProvider = (
  provider: ProviderDriverKind,
  overrides?: Partial<ServerProvider>,
): ServerProvider => ({
  instanceId: defaultInstanceIdForDriver(provider),
  driver: provider,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-11T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

it.layer(NodeServices.layer)("providerStatusCache", (it) => {
  it.effect(
    "replaces the cache after a temporary Windows file lock without removing the old file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-cache-lock-" });
        const filePath = yield* resolveProviderStatusCachePath({
          cacheDir: tempDir,
          instanceId: defaultInstanceIdForDriver(CODEX_DRIVER),
        });
        const original = makeProvider(CODEX_DRIVER);
        const refreshed = { ...original, checkedAt: "2026-04-11T00:01:00.000Z" };
        yield* writeProviderStatusCache({ filePath, provider: original });
        let attempts = 0;
        const lockedFileSystem = {
          ...fs,
          rename: (source, target) =>
            Effect.gen(function* () {
              attempts += 1;
              if (attempts <= 2) {
                assert.deepStrictEqual(yield* readProviderStatusCache(filePath), original);
                return yield* PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "rename",
                  cause: { code: "EPERM", syscall: "rename" },
                });
              }
              return yield* fs.rename(source, target);
            }),
        } satisfies FileSystem.FileSystem;

        yield* writeProviderStatusCache({ filePath, provider: refreshed }).pipe(
          Effect.provideService(FileSystem.FileSystem, lockedFileSystem),
          TestClock.withLive,
        );

        assert.deepStrictEqual(yield* readProviderStatusCache(filePath), refreshed);
        assert.deepStrictEqual(yield* fs.readDirectory(tempDir), ["codex.json"]);
      }),
  );

  for (const code of ["EPERM", "ENOSPC"] as const) {
    it.effect(`preserves the cache and reports a persistent ${code} replacement failure`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-cache-error-" });
        const filePath = yield* resolveProviderStatusCachePath({
          cacheDir: tempDir,
          instanceId: defaultInstanceIdForDriver(CODEX_DRIVER),
        });
        const original = makeProvider(CODEX_DRIVER);
        yield* writeProviderStatusCache({ filePath, provider: original });
        const failure = PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method: "rename",
          cause: { code, syscall: "rename" },
        });
        let attempts = 0;
        const failingFileSystem = {
          ...fs,
          rename: () =>
            Effect.suspend(() => {
              attempts += 1;
              return Effect.fail(failure);
            }),
        } satisfies FileSystem.FileSystem;

        const result = yield* writeProviderStatusCache({
          filePath,
          provider: { ...original, checkedAt: "2026-04-11T00:01:00.000Z" },
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, failingFileSystem),
          TestClock.withLive,
          Effect.result,
        );

        assert.ok(Result.isFailure(result));
        assert.strictEqual(result.failure, failure);
        assert.strictEqual(attempts, code === "EPERM" ? 11 : 1);
        assert.deepStrictEqual(yield* readProviderStatusCache(filePath), original);
        assert.deepStrictEqual(yield* fs.readDirectory(tempDir), ["codex.json"]);
      }),
    );
  }

  it.effect("writes and reads provider status snapshots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-cache-" });
      const codexProvider = makeProvider(CODEX_DRIVER);
      const claudeProvider = makeProvider(CLAUDE_AGENT_DRIVER, {
        status: "warning",
        auth: { status: "unknown" },
      });
      const openCodeProvider = makeProvider(OPENCODE_DRIVER, {
        status: "warning",
        auth: { status: "unknown", type: "opencode" },
      });
      const codexPath = yield* resolveProviderStatusCachePath({
        cacheDir: tempDir,
        instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
      });
      const claudePath = yield* resolveProviderStatusCachePath({
        cacheDir: tempDir,
        instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent")),
      });
      const openCodePath = yield* resolveProviderStatusCachePath({
        cacheDir: tempDir,
        instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("opencode")),
      });

      yield* writeProviderStatusCache({
        filePath: codexPath,
        provider: codexProvider,
      });
      yield* writeProviderStatusCache({
        filePath: claudePath,
        provider: claudeProvider,
      });
      yield* writeProviderStatusCache({
        filePath: openCodePath,
        provider: openCodeProvider,
      });

      assert.deepStrictEqual(yield* readProviderStatusCache(codexPath), codexProvider);
      assert.deepStrictEqual(yield* readProviderStatusCache(claudePath), claudeProvider);
      assert.deepStrictEqual(yield* readProviderStatusCache(openCodePath), openCodeProvider);
    }),
  );

  it("hydrates cached provider status while preserving current settings-derived models", () => {
    const cachedCodex = makeProvider(CODEX_DRIVER, {
      checkedAt: "2026-04-10T12:00:00.000Z",
      models: [
        {
          slug: "gpt-5-mini",
          name: "GPT-5 Mini",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
      message: "Cached message",
      skills: [
        {
          name: "github:gh-fix-ci",
          path: "/tmp/skills/gh-fix-ci/SKILL.md",
          enabled: true,
          displayName: "CI Debug",
        },
      ],
    });
    const fallbackCodex = makeProvider(CODEX_DRIVER, {
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
      message: "Pending refresh",
    });

    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: cachedCodex,
        fallbackProvider: fallbackCodex,
      }),
      {
        ...fallbackCodex,
        models: [
          ...fallbackCodex.models,
          {
            slug: "gpt-5-mini",
            name: "GPT-5 Mini",
            isCustom: false,
            capabilities: emptyCapabilities,
          },
        ],
        installed: cachedCodex.installed,
        version: cachedCodex.version,
        status: cachedCodex.status,
        auth: cachedCodex.auth,
        checkedAt: cachedCodex.checkedAt,
        slashCommands: cachedCodex.slashCommands,
        skills: cachedCodex.skills,
        message: cachedCodex.message,
      },
    );
  });

  it("ignores stale cached enabled state when the provider is now disabled", () => {
    const cachedCodex = makeProvider(CODEX_DRIVER, {
      checkedAt: "2026-04-10T12:00:00.000Z",
      message: "Cached ready status",
    });
    const disabledFallback = makeProvider(CODEX_DRIVER, {
      enabled: false,
      installed: false,
      version: null,
      status: "disabled",
      auth: { status: "unknown" },
      message: "Codex is disabled in Threadlines settings.",
    });

    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: cachedCodex,
        fallbackProvider: disabledFallback,
      }),
      disabledFallback,
    );
  });

  it("rejects cached snapshots that are not correlated to the fallback instance", () => {
    const fallbackCodex = makeProvider(CODEX_DRIVER, {
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
    });
    const legacyCachedCodex = {
      provider: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-04-10T12:00:00.000Z",
      models: [
        {
          slug: "cached-legacy-model",
          name: "Cached Legacy Model",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
      slashCommands: [],
      skills: [],
    } as unknown as ServerProvider;
    const mismatchedCachedCodex = makeProvider(CODEX_DRIVER, {
      instanceId: ProviderInstanceId.make("codex_personal"),
    });

    assert.strictEqual(
      isCachedProviderCorrelated({
        cachedProvider: legacyCachedCodex,
        fallbackProvider: fallbackCodex,
      }),
      false,
    );
    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: legacyCachedCodex,
        fallbackProvider: fallbackCodex,
      }),
      fallbackCodex,
    );
    assert.strictEqual(
      isCachedProviderCorrelated({
        cachedProvider: mismatchedCachedCodex,
        fallbackProvider: fallbackCodex,
      }),
      false,
    );
    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: mismatchedCachedCodex,
        fallbackProvider: fallbackCodex,
      }),
      fallbackCodex,
    );
  });
});
