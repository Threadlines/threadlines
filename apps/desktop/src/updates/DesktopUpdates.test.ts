import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DesktopUpdateState } from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopState from "../app/DesktopState.ts";
import {
  selectPrivateGitHubUpdateRelease,
  SortedPrivateGitHubProvider,
  type PrivateGitHubUpdateRelease,
} from "./PrivateGitHubUpdateProvider.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

interface UpdatesHarnessOptions {
  readonly checkForUpdates?: Effect.Effect<
    void,
    ElectronUpdater.ElectronUpdaterCheckForUpdatesError
  >;
  readonly env?: Record<string, string | undefined>;
  readonly resourcesPath?: string;
}

const flushCallbacks = Effect.yieldNow;

function makeRelease(
  input: Partial<PrivateGitHubUpdateRelease> & Pick<PrivateGitHubUpdateRelease, "tag_name">,
): PrivateGitHubUpdateRelease {
  return {
    draft: false,
    prerelease: false,
    created_at: "2026-06-15T00:00:00Z",
    published_at: "2026-06-15T00:00:00Z",
    assets: [{ name: "latest.yml", url: "https://api.github.com/assets/latest" }],
    ...input,
  };
}

function withProcessEnvPatch<A, E, R>(
  patch: Record<string, string | undefined>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(patch)) {
        previous[name] = process.env[name];
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = value;
          }
        }
      }),
  );
}

function makeHarness(options: UpdatesHarnessOptions = {}) {
  let checkCount = 0;
  let allowDowngrade = false;
  const feedUrls: ElectronUpdater.ElectronUpdaterFeedUrl[] = [];
  const listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>();
  const sentStates: DesktopUpdateState[] = [];

  const addListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName) ?? new Set();
    eventListeners.add(listener);
    listeners.set(eventName, eventListeners);
  };

  const removeListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName);
    if (!eventListeners) {
      return;
    }
    eventListeners.delete(listener);
    if (eventListeners.size === 0) {
      listeners.delete(eventName);
    }
  };

  const updaterLayer = Layer.succeed(ElectronUpdater.ElectronUpdater, {
    setLogger: () => Effect.void,
    setFeedURL: (options) =>
      Effect.sync(() => {
        feedUrls.push(options);
      }),
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: () => Effect.void,
    setChannel: () => Effect.void,
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.sync(() => allowDowngrade),
    setAllowDowngrade: (value) =>
      Effect.sync(() => {
        allowDowngrade = value;
      }),
    setDisableDifferentialDownload: () => Effect.void,
    checkForUpdates: Effect.sync(() => {
      checkCount += 1;
    }).pipe(Effect.andThen(options.checkForUpdates ?? Effect.void)),
    downloadUpdate: Effect.void,
    quitAndInstall: () => Effect.void,
    on: (eventName, listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          addListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
        }),
        () =>
          Effect.sync(() => {
            removeListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
          }),
      ).pipe(Effect.asVoid),
  } satisfies ElectronUpdater.ElectronUpdaterShape);

  const windowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected BrowserWindow creation"),
    main: Effect.succeed(Option.none()),
    currentMainOrFirst: Effect.succeed(Option.none()),
    focusedMainOrFirst: Effect.succeed(Option.none()),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    reveal: () => Effect.void,
    sendAll: (_channel, state) =>
      Effect.sync(() => {
        sentStates.push(state as DesktopUpdateState);
      }),
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindowShape);

  const backendLayer = Layer.succeed(DesktopBackendManager.DesktopBackendManager, {
    start: Effect.void,
    stop: () => Effect.void,
    currentConfig: Effect.succeed(Option.none()),
    snapshot: Effect.succeed({
      desiredRunning: false,
      ready: false,
      activePid: Option.none(),
      restartAttempt: 0,
      restartScheduled: false,
    }),
  });

  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: `/tmp/threadlines-desktop-updates-home-${process.pid}`,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: options.resourcesPath ?? "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          THREADLINES_HOME: `/tmp/threadlines-desktop-updates-test-${process.pid}`,
          THREADLINES_DESKTOP_MOCK_UPDATES: "true",
          THREADLINES_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
          ...options.env,
        }),
      ),
    ),
  );

  const layer = DesktopUpdates.layer.pipe(
    Layer.provideMerge(updaterLayer),
    Layer.provideMerge(windowLayer),
    Layer.provideMerge(backendLayer),
    Layer.provideMerge(DesktopState.layer),
    Layer.provideMerge(DesktopAppSettings.layer),
    Layer.provideMerge(
      DesktopConfig.layerTest({
        THREADLINES_HOME: `/tmp/threadlines-desktop-updates-test-${process.pid}`,
        THREADLINES_DESKTOP_MOCK_UPDATES: "true",
        THREADLINES_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
        ...options.env,
      }),
    ),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    layer,
    checkCount: () => checkCount,
    feedUrls: () => feedUrls,
    listenerCount: () =>
      Array.from(listeners.values()).reduce(
        (total, eventListeners) => total + eventListeners.size,
        0,
      ),
    sentStates,
    emit: (eventName: string, payload?: unknown) => {
      for (const listener of listeners.get(eventName) ?? []) {
        listener(payload);
      }
    },
  };
}

describe("resolvePrivateGitHubUpdateAuthToken", () => {
  const privateGitHubFeed = Option.some({
    provider: "github",
    owner: "badcuban",
    repo: "badcode",
    private: "true",
  });

  it("prefers GH_TOKEN over GitHub CLI auth", () => {
    const authToken = DesktopUpdates.resolvePrivateGitHubUpdateAuthToken({
      appUpdateYmlConfig: privateGitHubFeed,
      env: { GH_TOKEN: "env-token" },
      githubCliToken: Option.some("cli-token"),
    });

    assert.deepEqual(Option.getOrUndefined(authToken), {
      source: "env",
      envName: "GH_TOKEN",
      token: "env-token",
    });
  });

  it("uses GitHub CLI auth when the private feed has no token env", () => {
    const authToken = DesktopUpdates.resolvePrivateGitHubUpdateAuthToken({
      appUpdateYmlConfig: privateGitHubFeed,
      env: {},
      githubCliToken: Option.some("cli-token"),
    });

    assert.deepEqual(Option.getOrUndefined(authToken), {
      source: "github-cli",
      token: "cli-token",
    });
  });

  it("does not request auth for public or non-GitHub update feeds", () => {
    const publicGitHubToken = DesktopUpdates.resolvePrivateGitHubUpdateAuthToken({
      appUpdateYmlConfig: Option.some({ provider: "github" }),
      env: { GH_TOKEN: "env-token" },
      githubCliToken: Option.some("cli-token"),
    });
    const genericToken = DesktopUpdates.resolvePrivateGitHubUpdateAuthToken({
      appUpdateYmlConfig: Option.some({ provider: "generic", url: "https://example.invalid" }),
      env: { GH_TOKEN: "env-token" },
      githubCliToken: Option.some("cli-token"),
    });

    assert.isTrue(Option.isNone(publicGitHubToken));
    assert.isTrue(Option.isNone(genericToken));
  });

  it("returns none when a private GitHub feed has no runtime token", () => {
    const authToken = DesktopUpdates.resolvePrivateGitHubUpdateAuthToken({
      appUpdateYmlConfig: privateGitHubFeed,
      env: {},
      githubCliToken: Option.none(),
    });

    assert.isTrue(Option.isNone(authToken));
  });
});

describe("selectPrivateGitHubUpdateRelease", () => {
  it("selects the newest nightly by semver while skipping drafts and GitHub API ordering", () => {
    const release = selectPrivateGitHubUpdateRelease({
      channel: "nightly",
      releaseType: "prerelease",
      channelFile: "latest.yml",
      releases: [
        makeRelease({
          tag_name: "v0.0.21-nightly.20260615.100",
          draft: true,
          prerelease: true,
          published_at: null,
        }),
        makeRelease({
          tag_name: "v0.0.21-nightly.20260615.99",
          prerelease: true,
          published_at: "2026-06-15T04:44:57Z",
        }),
        makeRelease({
          tag_name: "v0.0.21-nightly.20260615.98",
          prerelease: true,
          published_at: "2026-06-15T00:39:57Z",
        }),
        makeRelease({
          tag_name: "v0.0.21-nightly.20260615.101",
          prerelease: true,
          published_at: "2026-06-15T08:40:23Z",
        }),
      ],
    });

    assert.equal(release?.tag_name, "v0.0.21-nightly.20260615.101");
  });

  it("keeps stable updates on stable releases even when newer prereleases exist", () => {
    const release = selectPrivateGitHubUpdateRelease({
      channel: "latest",
      releaseType: "release",
      channelFile: "latest.yml",
      releases: [
        makeRelease({
          tag_name: "v1.2.4-nightly.20260615.101",
          prerelease: true,
          published_at: "2026-06-15T08:40:23Z",
        }),
        makeRelease({
          tag_name: "v1.2.4",
          draft: true,
          published_at: null,
        }),
        makeRelease({
          tag_name: "v1.2.3",
          published_at: "2026-06-14T12:00:00Z",
        }),
        makeRelease({
          tag_name: "v1.2.2",
          published_at: "2026-06-13T12:00:00Z",
        }),
      ],
    });

    assert.equal(release?.tag_name, "v1.2.3");
  });

  it("skips releases that are missing the required platform manifest", () => {
    const release = selectPrivateGitHubUpdateRelease({
      channel: "nightly",
      releaseType: "prerelease",
      channelFile: "latest.yml",
      releases: [
        makeRelease({
          tag_name: "v0.0.21-nightly.20260615.102",
          prerelease: true,
          assets: [{ name: "latest-mac.yml", url: "https://api.github.com/assets/latest-mac" }],
          published_at: "2026-06-15T09:00:00Z",
        }),
        makeRelease({
          tag_name: "v0.0.21-nightly.20260615.101",
          prerelease: true,
          published_at: "2026-06-15T08:40:23Z",
        }),
      ],
    });

    assert.equal(release?.tag_name, "v0.0.21-nightly.20260615.101");
  });
});

describe("DesktopUpdates", () => {
  it.effect("configures the updater and runs startup checks on the test clock", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const state = yield* updates.getState;
          assert.equal(state.enabled, true);
          assert.equal(state.status, "idle");
          assert.deepEqual(harness.feedUrls(), [
            { provider: "generic", url: "http://localhost:4141" },
          ]);
          assert.equal(harness.listenerCount(), 6);
          assert.equal(harness.checkCount(), 0);

          yield* TestClock.adjust(Duration.millis(15_000));
          assert.equal(harness.checkCount(), 1);
        }),
      );

      assert.equal(harness.listenerCount(), 0);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("configures an authenticated private GitHub feed before the first check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resourcesPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "threadlines-private-updates-",
        });
        yield* fileSystem.writeFileString(
          path.join(resourcesPath, "app-update.yml"),
          [
            "provider: github",
            "owner: badcuban",
            "repo: badcode",
            "private: true",
            "releaseType: prerelease",
            "channel: nightly",
            "",
          ].join("\n"),
        );

        const harness = makeHarness({
          resourcesPath,
          env: {
            THREADLINES_DESKTOP_MOCK_UPDATES: "false",
          },
        });

        yield* withProcessEnvPatch(
          { GH_TOKEN: "env-token", GITHUB_TOKEN: undefined },
          Effect.scoped(
            Effect.gen(function* () {
              const updates = yield* DesktopUpdates.DesktopUpdates;
              yield* updates.configure;
              const result = yield* updates.check("manual");

              assert.equal(result.checked, true);
              assert.equal(harness.checkCount(), 1);
              const feedUrl = harness.feedUrls()[0] as Record<string, unknown> | undefined;
              assert.equal(feedUrl?.provider, "custom");
              assert.equal(feedUrl?.owner, "badcuban");
              assert.equal(feedUrl?.repo, "badcode");
              assert.equal(feedUrl?.private, true);
              assert.equal(feedUrl?.token, "env-token");
              assert.equal(feedUrl?.releaseType, "prerelease");
              assert.equal(feedUrl?.channel, "nightly");
              assert.equal(feedUrl?.updateProvider, SortedPrivateGitHubProvider);
            }),
          ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer))),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("updates and broadcasts state from updater events", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.availableVersion, "1.2.4");
        assert.isNotNull(state.checkedAt);
        assert.equal(harness.sentStates.at(-1)?.status, "available");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("uses a dev-only preview update state without configuring the updater", () => {
    const harness = makeHarness({
      env: {
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
        THREADLINES_DESKTOP_PREVIEW_UPDATE_STATE: "available",
        THREADLINES_DESKTOP_PREVIEW_UPDATE_VERSION: "9.9.9",
      },
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.getState;
        assert.equal(state.enabled, true);
        assert.equal(state.status, "available");
        assert.equal(state.availableVersion, "9.9.9");
        assert.equal(state.currentVersion, "1.2.3");
        assert.isNotNull(state.checkedAt);
        assert.deepEqual(harness.feedUrls(), []);
        assert.equal(harness.listenerCount(), 0);
        assert.equal(harness.checkCount(), 0);
        assert.equal(harness.sentStates.at(-1)?.status, "available");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("persists channel changes through the settings service", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.setChannel("nightly");
        const persistedSettings = yield* settings.get;

        assert.equal(state.channel, "nightly");
        assert.equal(persistedSettings.updateChannel, "nightly");
        assert.equal(persistedSettings.updateChannelConfiguredByUser, true);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("does not persist an unchanged update channel as a user preference", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.setChannel("latest");
        const persistedSettings = yield* settings.get;

        assert.equal(state.channel, "latest");
        assert.equal(persistedSettings.updateChannel, "latest");
        assert.equal(persistedSettings.updateChannelConfiguredByUser, false);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("fails channel changes with a typed error while a check is in progress", () =>
    Effect.gen(function* () {
      const checkStarted = yield* Deferred.make<void>();
      const releaseCheck = yield* Deferred.make<void>();
      const harness = makeHarness({
        checkForUpdates: Deferred.succeed(checkStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCheck)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const checkFiber = yield* updates.check("manual").pipe(Effect.forkScoped);
          yield* Deferred.await(checkStarted);

          const exit = yield* Effect.exit(updates.setChannel("nightly"));
          assert.equal(exit._tag, "Failure");
          if (exit._tag === "Failure") {
            const error = Cause.squash(exit.cause);
            assert.instanceOf(error, DesktopUpdates.DesktopUpdateActionInProgressError);
            assert.equal(error.action, "check");
          }

          yield* Deferred.succeed(releaseCheck, undefined);
          yield* Fiber.join(checkFiber);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );
});
