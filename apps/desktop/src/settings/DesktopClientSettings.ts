import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type ClientSettingsPatch,
} from "@threadlines/contracts";
import { fromLenientJson } from "@threadlines/shared/schemaJson";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

const ClientSettingsDocumentSchema = Schema.Struct({
  settings: ClientSettingsSchema,
});

const ClientSettingsJson = fromLenientJson(ClientSettingsSchema);
const LegacyClientSettingsDocumentJson = fromLenientJson(ClientSettingsDocumentSchema);
const decodeLegacyClientSettingsDocumentJson = Schema.decodeEffect(
  LegacyClientSettingsDocumentJson,
);
const decodeClientSettingsJsonValue = Schema.decodeEffect(ClientSettingsJson);
const decodeClientSettingsJson = (raw: string): Effect.Effect<ClientSettings, Schema.SchemaError> =>
  decodeLegacyClientSettingsDocumentJson(raw).pipe(
    Effect.map((document) => document.settings),
    Effect.catch(() => decodeClientSettingsJsonValue(raw)),
  );
const encodeClientSettingsJson = Schema.encodeEffect(ClientSettingsJson);

export class DesktopClientSettingsWriteError extends Data.TaggedError(
  "DesktopClientSettingsWriteError",
)<{
  readonly cause: PlatformError.PlatformError | Schema.SchemaError;
}> {
  override get message() {
    return `Failed to write desktop client settings: ${this.cause.message}`;
  }
}

export interface DesktopClientSettingsShape {
  readonly get: Effect.Effect<Option.Option<ClientSettings>>;
  /**
   * Stores the patch over what is stored now and returns the stored settings.
   * Updates run one at a time, so a window only ever changes the settings it
   * names, and every app window hears the result in the order they landed.
   */
  readonly update: (
    patch: ClientSettingsPatch,
  ) => Effect.Effect<ClientSettings, DesktopClientSettingsWriteError>;
}

export class DesktopClientSettings extends Context.Service<
  DesktopClientSettings,
  DesktopClientSettingsShape
>()("threadlines/desktop/ClientSettings") {}

const decodeStoredClientSettings = (raw: string): Effect.Effect<Option.Option<ClientSettings>> =>
  decodeClientSettingsJson(raw).pipe(
    Effect.map((settings) => Option.some(settings)),
    Effect.catch(() => Effect.succeed(Option.none<ClientSettings>())),
  );

const readClientSettings = (
  fileSystem: FileSystem.FileSystem,
  settingsPath: string,
): Effect.Effect<Option.Option<ClientSettings>> =>
  fileSystem.readFileString(settingsPath).pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<ClientSettings>()),
        onSome: decodeStoredClientSettings,
      }),
    ),
  );

/**
 * What an update merges over. No file, or one that doesn't decode, starts from
 * the defaults, as `get` would have. A file that can't be read fails instead:
 * saving defaults over it would lose every setting to a passing disk error.
 */
const readClientSettingsToMerge = (
  fileSystem: FileSystem.FileSystem,
  settingsPath: string,
): Effect.Effect<ClientSettings, PlatformError.PlatformError> =>
  fileSystem.readFileString(settingsPath).pipe(
    Effect.flatMap(decodeStoredClientSettings),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(Option.none<ClientSettings>()),
    ),
    Effect.map(Option.getOrElse(() => DEFAULT_CLIENT_SETTINGS)),
  );

const writeClientSettings = Effect.fnUntraced(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly settingsPath: string;
  readonly settings: ClientSettings;
}): Effect.fn.Return<void, PlatformError.PlatformError | Schema.SchemaError> {
  const directory = input.path.dirname(input.settingsPath);
  const suffix = (yield* randomUUIDv4).replace(/-/g, "");
  const tempPath = `${input.settingsPath}.${process.pid}.${suffix}.tmp`;
  const encoded = yield* encodeClientSettingsJson(input.settings);
  yield* input.fileSystem.makeDirectory(directory, { recursive: true });
  yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`);
  yield* input.fileSystem.rename(tempPath, input.settingsPath);
});

export const layer = Layer.effect(
  DesktopClientSettings,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const settingsPath = environment.clientSettingsPath;
    // Reads take it too, so a window that reads never sees a file older than a
    // change it has already heard about.
    const lock = yield* Semaphore.make(1);

    return DesktopClientSettings.of({
      get: lock
        .withPermits(1)(readClientSettings(fileSystem, settingsPath))
        .pipe(Effect.withSpan("desktop.clientSettings.get")),
      update: (patch) =>
        lock
          .withPermits(1)(
            Effect.gen(function* () {
              const current = yield* readClientSettingsToMerge(fileSystem, settingsPath);
              const settings: ClientSettings = { ...current, ...patch };
              yield* writeClientSettings({ fileSystem, path, settingsPath, settings });
              // Every window: the one that saved already holds these, so for it
              // they change nothing. They are on disk, so a window that can't be
              // told doesn't make the save a failure.
              yield* electronWindow
                .sendAll(IpcChannels.CLIENT_SETTINGS_CHANGED_CHANNEL, settings)
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("failed to announce client settings change", cause),
                  ),
                );
              return settings;
            }),
          )
          .pipe(
            Effect.mapError((cause) => new DesktopClientSettingsWriteError({ cause })),
            Effect.withSpan("desktop.clientSettings.update"),
          ),
    });
  }),
);

export const layerTest = (initialSettings: Option.Option<ClientSettings> = Option.none()) =>
  Layer.effect(
    DesktopClientSettings,
    Effect.gen(function* () {
      const settingsRef = yield* Ref.make(initialSettings);
      return DesktopClientSettings.of({
        get: Ref.get(settingsRef),
        update: (patch) =>
          Ref.modify(settingsRef, (current) => {
            const settings: ClientSettings = {
              ...Option.getOrElse(current, () => DEFAULT_CLIENT_SETTINGS),
              ...patch,
            };
            return [settings, Option.some(settings)] as const;
          }),
      });
    }),
  );
