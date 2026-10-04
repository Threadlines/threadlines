import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAuthSessions } from "../auth/ProviderAuthSessions.ts";
import { deriveProviderInstanceConfigMap } from "../Layers/ProviderInstanceRegistryHydration.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import {
  allocateAccountInstanceId,
  ProviderAccounts,
  ProviderAccountsLive,
} from "./ProviderAccounts.ts";

const encoder = new TextEncoder();

interface SpawnedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string | undefined>;
}

/** Records sign-out commands instead of running a real CLI; they exit with `exitCode`. */
function recordingSpawner(spawned: SpawnedCommand[], exitCode = 0) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const standard = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly options: { readonly env?: Record<string, string | undefined> };
      };
      spawned.push({
        command: standard.command,
        args: standard.args,
        env: standard.options.env ?? {},
      });
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode("")),
          stderr: Stream.make(encoder.encode("")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );
}

/**
 * A registry whose instances are the ones in settings, plus any id in
 * `stillRunning`: an instance that hasn't finished shutting down.
 */
const settingsBackedRegistry = (stillRunning: Set<string>) =>
  Layer.effect(
    ProviderInstanceRegistry,
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      return ProviderInstanceRegistry.of({
        getInstance: (instanceId: ProviderInstanceId) =>
          settings.getSettings.pipe(
            Effect.map((current) =>
              instanceId in deriveProviderInstanceConfigMap(current) ||
              stillRunning.has(String(instanceId))
                ? ({} as ProviderInstance)
                : undefined,
            ),
            Effect.orDie,
          ),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.die("unused"),
      } as never);
    }),
  );

function makeLayer(
  spawned: SpawnedCommand[],
  options: { readonly exitCode?: number; readonly stillRunning?: Set<string> } = {},
) {
  return ProviderAccountsLive.pipe(
    Layer.provideMerge(settingsBackedRegistry(options.stillRunning ?? new Set())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(Layer.mock(ProviderAuthSessions)({ stop: () => Effect.void })),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "threadlines-accounts-test-" })),
    ),
    Layer.provideMerge(recordingSpawner(spawned, options.exitCode)),
  );
}

describe("allocateAccountInstanceId", () => {
  it("never hands out an id already in use", () => {
    const randoms = ["aaaa", "bbbb"];
    const id = allocateAccountInstanceId({
      driver: "claudeAgent",
      displayName: "Work",
      taken: (candidate) => candidate === "claudeAgent_work_aaaa",
      random: () => randoms.shift()!,
    });
    expect(id).toBe("claudeAgent_work_bbbb");
  });

  it("falls back to a plain slug for names without latin letters", () => {
    expect(
      allocateAccountInstanceId({
        driver: "codex",
        displayName: "仕事",
        taken: () => false,
        random: () => "0f0f",
      }),
    ).toBe("codex_account_0f0f");
  });
});

it.layer(NodeServices.layer)("ProviderAccounts", (it) => {
  it.effect("adds an account with its own folder and a settings entry", () => {
    const spawned: SpawnedCommand[] = [];
    return Effect.gen(function* () {
      const accounts = yield* ProviderAccounts;
      const settings = yield* ServerSettingsService;
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const { instanceId } = yield* accounts.add({
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Work",
        accentColor: "#16a34a",
      });

      expect(instanceId).toMatch(/^claudeAgent_work_[0-9a-f]{6}$/);
      const folder = path.join(config.stateDir, "accounts", instanceId);
      const instance = (yield* settings.getSettings).providerInstances[instanceId];
      expect(instance).toMatchObject({
        driver: "claudeAgent",
        displayName: "Work",
        accentColor: "#16a34a",
        enabled: true,
        config: { accountFolder: folder },
      });
      expect(yield* fileSystem.exists(path.join(folder, ".threadlines-account"))).toBe(true);
    }).pipe(Effect.provide(makeLayer(spawned)));
  });

  it.effect("refuses a folder that holds the main login or another account's", () => {
    const spawned: SpawnedCommand[] = [];
    return Effect.gen(function* () {
      const accounts = yield* ProviderAccounts;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const chosen = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tl-account-chosen-" });

      // The home folder contains `~/.claude`, the terminal's own login.
      const home = yield* accounts
        .add({
          driver: ProviderDriverKind.make("claudeAgent"),
          displayName: "Home",
          folder: NodeOS.homedir(),
        })
        .pipe(Effect.flip);
      expect(home.reason).toBe("invalidFolder");

      yield* accounts.add({
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Mine",
        folder: chosen,
      });
      const nested = yield* accounts
        .add({
          driver: ProviderDriverKind.make("codex"),
          displayName: "Nested",
          folder: path.join(chosen, "inner"),
        })
        .pipe(Effect.flip);
      expect(nested.reason).toBe("invalidFolder");
    }).pipe(Effect.scoped, Effect.provide(makeLayer(spawned)));
  });

  it.effect("removing a managed account signs it out and deletes its folder", () => {
    const spawned: SpawnedCommand[] = [];
    return Effect.gen(function* () {
      const accounts = yield* ProviderAccounts;
      const settings = yield* ServerSettingsService;
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const { instanceId } = yield* accounts.add({
        driver: ProviderDriverKind.make("codex"),
        displayName: "Work",
      });
      const folder = path.join(config.stateDir, "accounts", instanceId);
      yield* accounts.remove({ instanceId });

      expect((yield* settings.getSettings).providerInstances[instanceId]).toBeUndefined();
      expect(yield* fileSystem.exists(folder)).toBe(false);
      expect(spawned.map((entry) => [entry.command, ...entry.args])).toEqual([["codex", "logout"]]);
      expect(spawned[0]?.env.CODEX_HOME).toBe(folder);
      expect(
        yield* fileSystem.exists(
          path.join(config.stateDir, "accounts", ".cleanup", `${instanceId}.json`),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(makeLayer(spawned)));
  });

  it.effect("removing an account in a chosen folder leaves the folder and its login alone", () => {
    const spawned: SpawnedCommand[] = [];
    return Effect.gen(function* () {
      const accounts = yield* ProviderAccounts;
      const fileSystem = yield* FileSystem.FileSystem;
      const chosen = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tl-account-kept-" });

      const { instanceId } = yield* accounts.add({
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Mine",
        folder: chosen,
      });
      yield* accounts.remove({ instanceId });

      expect(yield* fileSystem.exists(chosen)).toBe(true);
      expect(spawned).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(makeLayer(spawned)));
  });

  it.effect("an agent's own row cannot be removed", () => {
    const spawned: SpawnedCommand[] = [];
    return Effect.gen(function* () {
      const accounts = yield* ProviderAccounts;
      const error = yield* accounts
        .remove({ instanceId: ProviderInstanceId.make("codex") })
        .pipe(Effect.flip);
      expect(error.reason).toBe("notAnAccount");
    }).pipe(Effect.provide(makeLayer(spawned)));
  });
  it.effect("keeps the folder and its cleanup record when sign-out fails", () => {
    const spawned: SpawnedCommand[] = [];
    return Effect.gen(function* () {
      const accounts = yield* ProviderAccounts;
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const { instanceId } = yield* accounts.add({
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Work",
      });
      yield* accounts.remove({ instanceId });

      expect(spawned.map((entry) => entry.args)).toEqual([["auth", "logout"]]);
      expect(yield* fileSystem.exists(path.join(config.stateDir, "accounts", instanceId))).toBe(
        true,
      );
      expect(
        yield* fileSystem.exists(
          path.join(config.stateDir, "accounts", ".cleanup", `${instanceId}.json`),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(makeLayer(spawned, { exitCode: 1 })));
  });

  it.effect("lets only one of two concurrent adds claim a chosen folder", () => {
    const spawned: SpawnedCommand[] = [];
    return Effect.gen(function* () {
      const accounts = yield* ProviderAccounts;
      const fileSystem = yield* FileSystem.FileSystem;
      const chosen = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tl-account-race-" });
      const add = (displayName: string) =>
        accounts
          .add({ driver: ProviderDriverKind.make("claudeAgent"), displayName, folder: chosen })
          .pipe(Effect.result);

      const results = yield* Effect.all([add("One"), add("Two")], { concurrency: "unbounded" });

      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(makeLayer(spawned)));
  });

  it.effect("never gives a removed account's id to a new one", () => {
    const spawned: SpawnedCommand[] = [];
    return Effect.gen(function* () {
      const accounts = yield* ProviderAccounts;
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const { instanceId } = yield* accounts.add({
        driver: ProviderDriverKind.make("codex"),
        displayName: "Work",
      });
      yield* accounts.remove({ instanceId });

      expect(
        yield* fileSystem.exists(path.join(config.stateDir, "accounts", ".retired", instanceId)),
      ).toBe(true);
    }).pipe(Effect.provide(makeLayer(spawned)));
  });
});

// Real time: removal polls the registry until the account has stopped.
it.live("signs out and deletes only after the account has stopped running", () => {
  const spawned: SpawnedCommand[] = [];
  const stillRunning = new Set<string>();
  return Effect.gen(function* () {
    const accounts = yield* ProviderAccounts;
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const { instanceId } = yield* accounts.add({
      driver: ProviderDriverKind.make("codex"),
      displayName: "Work",
    });
    const folder = path.join(config.stateDir, "accounts", instanceId);
    stillRunning.add(instanceId);
    const removal = yield* accounts.remove({ instanceId }).pipe(Effect.forkChild);
    yield* Effect.sleep("300 millis");
    expect(spawned).toEqual([]);
    expect(yield* fileSystem.exists(folder)).toBe(true);

    stillRunning.delete(instanceId);
    yield* Fiber.join(removal);
    expect(spawned.map((entry) => entry.args)).toEqual([["logout"]]);
    expect(yield* fileSystem.exists(folder)).toBe(false);
  }).pipe(Effect.provide(makeLayer(spawned, { stillRunning })), Effect.provide(NodeServices.layer));
});
