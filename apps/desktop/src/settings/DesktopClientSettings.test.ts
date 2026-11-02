import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClientSettingsSchema, type ClientSettings } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopClientSettings from "./DesktopClientSettings.ts";

const clientSettings: ClientSettings = {
  agentBrowserApprovedDomains: {},
  agentBrowserSitePolicy: "ask",
  agentBrowserProjectSitePolicy: {},
  agentBrowserTrustedCertificates: {},
  browserNewTabSize: null,
  browserSignIns: "shared",
  autoOpenAgentsPanel: false,
  chatChangedFilesDefaultExpanded: false,
  confirmThreadArchive: true,
  confirmThreadDelete: false,
  wrapUpThreadsOnPullRequestSettled: true,
  wrapUpChildThreadsOnFinish: true,
  wrapUpIdleThreads: true,
  dismissedProviderUpdateNotificationKeys: [],
  dictationHoldToRecord: true,
  dictationMicrophoneDeviceId: null,
  diffChangesOnly: false,
  diffIgnoreWhitespace: true,
  diffRenderMode: "stacked",
  diffWordWrap: true,
  fileViewerWordWrap: false,
  terminalFontSize: 12,
  terminalScreenReaderMode: false,
  followUpDelivery: "steer",
  favorites: [],
  openLinksIn: "browser-panel",
  providerModelPreferences: {},
  suppressCrossProviderSwitchWarning: false,
  sidebarGrouping: "none",
  inboxSort: "recent",
  inboxCustomOrder: [],
  inboxGroupOrder: [],
  sidebarProjectGroupingMode: "repository_path",
  sidebarProjectGroupingOverrides: {
    "environment-1:/tmp/project-a": "separate",
  },
  sidebarProjectSortOrder: "manual",
  sidebarThreadPreviewCount: 6,
  sourceControlPanelDefaultOpen: false,
  timestampFormat: "24-hour",
};

const decodeClientSettingsJson = Schema.decodeEffect(Schema.fromJsonString(ClientSettingsSchema));
const decodeRecordJson = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

function makeLayer(baseDir: string, sent: Array<{ channel: string; settings: unknown }> = []) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ THREADLINES_HOME: baseDir })),
    ),
  );

  const windowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    workAreaSize: Effect.succeed({ width: 1920, height: 1080 }),
    create: () => Effect.die("unexpected BrowserWindow creation"),
    main: Effect.succeed(Option.none()),
    currentMainOrFirst: Effect.succeed(Option.none()),
    focusedMainOrFirst: Effect.succeed(Option.none()),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    reveal: () => Effect.void,
    guestsOf: () => Effect.succeed([]),
    sendAll: (channel, settings) =>
      Effect.sync(() => {
        sent.push({ channel, settings });
      }),
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindowShape);

  return DesktopClientSettings.layer.pipe(
    Layer.provide(windowLayer),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

const withClientSettings = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopClientSettings.DesktopClientSettings>,
  sent: Array<{ channel: string; settings: unknown }> = [],
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-client-settings-test-",
    });
    return yield* effect.pipe(Effect.provide(makeLayer(baseDir, sent)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopClientSettings", () => {
  it.effect("returns none when no client settings file exists", () =>
    withClientSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        assert.isTrue(Option.isNone(yield* settings.get));
      }),
    ),
  );

  it.effect("persists and reloads client settings", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        assert.deepEqual(yield* settings.update(clientSettings), clientSettings);

        assert.deepEqual(yield* settings.get, Option.some(clientSettings));
        assert.deepEqual(
          yield* decodeClientSettingsJson(
            yield* fileSystem.readFileString(environment.clientSettingsPath),
          ),
          clientSettings,
        );
        assert.isFalse(
          Object.hasOwn(
            yield* decodeRecordJson(
              yield* fileSystem.readFileString(environment.clientSettingsPath),
            ),
            "settings",
          ),
        );
      }),
    ),
  );

  it.effect("loads lenient direct client settings documents", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.clientSettingsPath,
          `{
            // Matches server settings parsing.
            "timestampFormat": "24-hour",
          }\n`,
        );

        const persisted = yield* settings.get;
        assert.isTrue(Option.isSome(persisted));
        if (Option.isSome(persisted)) {
          assert.equal(persisted.value.timestampFormat, "24-hour");
        }
      }),
    ),
  );

  it.effect("loads legacy wrapped client settings documents", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.clientSettingsPath,
          `{
            "settings": {
              "timestampFormat": "12-hour"
            }
          }\n`,
        );

        const persisted = yield* settings.get;
        assert.isTrue(Option.isSome(persisted));
        if (Option.isSome(persisted)) {
          assert.equal(persisted.value.timestampFormat, "12-hour");
        }
      }),
    ),
  );

  it.effect("loads defaults from empty client settings documents", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.clientSettingsPath, "{}\n");

        assert.deepEqual(yield* settings.get, Option.some(yield* decodeClientSettingsJson("{}")));
      }),
    ),
  );

  it.effect("treats malformed client settings documents as absent", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.clientSettingsPath, "{not-json");

        assert.isTrue(Option.isNone(yield* settings.get));
      }),
    ),
  );

  it.effect("merges every window's update over the stored settings, and tells every window", () => {
    const sent: Array<{ channel: string; settings: unknown }> = [];
    return withClientSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* settings.update(clientSettings);

        // Two windows save different settings at once. Neither names the other's.
        yield* Effect.all(
          [
            settings.update({ timestampFormat: "12-hour" }),
            settings.update({ diffWordWrap: false }),
          ],
          { concurrency: "unbounded" },
        );

        const expected = { ...clientSettings, timestampFormat: "12-hour", diffWordWrap: false };
        assert.deepEqual(yield* settings.get, Option.some(expected as ClientSettings));
        assert.equal(sent.at(-1)?.channel, IpcChannels.CLIENT_SETTINGS_CHANGED_CHANNEL);
        assert.deepEqual(sent.at(-1)?.settings, expected);
        assert.lengthOf(sent, 3);
      }),
      sent,
    );
  });

  it.effect("merges over an older wrapped document and rewrites it unwrapped", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.clientSettingsPath,
          `{ "settings": { "timestampFormat": "12-hour" } }\n`,
        );

        const stored = yield* settings.update({ diffWordWrap: false });

        assert.equal(stored.timestampFormat, "12-hour");
        assert.isFalse(stored.diffWordWrap);
        assert.deepEqual(yield* settings.get, Option.some(stored));
      }),
    ),
  );

  it.effect("fails an update rather than save defaults over a file it can't read", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        // A folder where the file belongs: a read error that isn't "no such file".
        yield* fileSystem.makeDirectory(environment.clientSettingsPath, { recursive: true });

        const error = yield* Effect.flip(settings.update({ diffWordWrap: false }));
        assert.instanceOf(error, DesktopClientSettings.DesktopClientSettingsWriteError);
      }),
    ),
  );
});
