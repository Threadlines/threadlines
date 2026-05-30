import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  type ServerSettings as ServerSettingsContract,
} from "@t3tools/contracts";

import {
  isCodexAppsDirectoryAccessDeniedError,
  parseClaudePluginList,
  readProviderExtensionsInventory,
} from "./providerExtensions.ts";

const encoder = new TextEncoder();
const decodeServerSettings = Schema.decodeSync(ServerSettings);

function makeNeverFinishingProcess() {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function makeProcessResult(stdout: string, stderr = "", code = 0) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(456),
    stdout: Stream.make(encoder.encode(stdout)),
    stderr: Stream.make(encoder.encode(stderr)),
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function makeSettings(overrides: Record<string, unknown> = {}): ServerSettingsContract {
  return decodeServerSettings({
    providers: {
      codex: { enabled: true, binaryPath: "codex" },
      claudeAgent: { enabled: false },
      cursor: { enabled: false },
      opencode: { enabled: false },
    },
    ...overrides,
  });
}

describe("provider extensions inventory", () => {
  it("treats Codex app-directory 403s as optional inventory misses", () => {
    assert.equal(
      isCodexAppsDirectoryAccessDeniedError(
        new Error("failed to list apps: Request failed with status 403 Forbidden: <html>"),
      ),
      true,
    );
    assert.equal(
      isCodexAppsDirectoryAccessDeniedError(
        new Error("failed to list apps: Request failed with status 500 Internal Server Error"),
      ),
      false,
    );
  });

  it("parses Claude plugin JSON inventory with installed and marketplace entries", () => {
    const plugins = parseClaudePluginList(
      JSON.stringify({
        installed: [
          {
            id: "supabase@claude-plugins-official",
            version: "0.1.9",
            scope: "user",
            enabled: false,
            installPath: "C:\\Users\\wilfr\\.claude\\plugins\\cache\\supabase\\0.1.9",
            installedAt: "2026-04-20T08:59:41.934Z",
            lastUpdated: "2026-05-29T03:28:06.201Z",
          },
        ],
        available: [
          {
            pluginId: "supabase@claude-plugins-official",
            name: "supabase",
            description: "Supabase MCP integration",
            marketplaceName: "claude-plugins-official",
            source: { url: "https://github.com/supabase-community/supabase-plugin.git" },
            installCount: 100599,
          },
          {
            pluginId: "vercel@claude-plugins-official",
            name: "vercel",
            description: "Vercel integration",
            marketplaceName: "claude-plugins-official",
          },
        ],
      }),
    );

    assert.equal(plugins[0]?.id, "supabase@claude-plugins-official");
    assert.equal(plugins[0]?.name, "supabase");
    assert.equal(plugins[0]?.enabled, false);
    assert.equal(plugins[0]?.installed, true);
    assert.equal(plugins[0]?.description, "Supabase MCP integration");
    assert.equal(plugins[0]?.installCount, 100599);
    assert.equal(plugins[1]?.id, "vercel@claude-plugins-official");
    assert.equal(plugins[1]?.installed, false);
  });

  it.effect(
    "returns a Codex provider error instead of hanging when app-server never responds",
    () => {
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(makeNeverFinishingProcess()));
      const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
      const layer = Layer.mergeAll(NodeServices.layer, spawnerLayer, TestClock.layer());

      return Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          readProviderExtensionsInventory({
            request: { cwd: process.cwd() },
            settings: makeSettings(),
            providers: [],
          }),
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.seconds(20));

        const result = yield* Fiber.join(fiber);
        const codex = result.providers.find(
          (provider) => provider.instanceId === ProviderInstanceId.make("codex"),
        );

        assert.equal(codex?.driver, ProviderDriverKind.make("codex"));
        assert.equal(codex?.status, "error");
        assert.equal(codex?.message, "Timed out reading Codex extension inventory.");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("keeps disabled provider inventory local without spawning provider commands", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeProcessResult("", "unexpected spawn", 1)),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);

    return Effect.gen(function* () {
      const result = yield* readProviderExtensionsInventory({
        request: { cwd: process.cwd() },
        settings: makeSettings({
          providers: {
            codex: { enabled: false },
            claudeAgent: { enabled: false },
            cursor: { enabled: false },
            opencode: { enabled: false },
          },
        }),
        providers: [],
      });
      const codex = result.providers.find(
        (provider) => provider.instanceId === ProviderInstanceId.make("codex"),
      );

      assert.equal(codex?.status, "disabled");
      assert.equal(codex?.message, "Provider is disabled.");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, spawnerLayer)));
  });

  it.effect("filters inventory to the requested provider instance", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeProcessResult("", "unexpected spawn", 1)),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);

    return Effect.gen(function* () {
      const result = yield* readProviderExtensionsInventory({
        request: {
          cwd: process.cwd(),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        },
        settings: makeSettings({
          providers: {
            codex: { enabled: false },
            claudeAgent: { enabled: false },
            cursor: { enabled: false },
            opencode: { enabled: false },
          },
        }),
        providers: [],
      });

      assert.deepEqual(
        result.providers.map((provider) => provider.instanceId),
        [ProviderInstanceId.make("claudeAgent")],
      );
      assert.equal(result.providers[0]?.status, "disabled");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, spawnerLayer)));
  });
});
