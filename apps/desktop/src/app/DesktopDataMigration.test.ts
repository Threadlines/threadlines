import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopDataMigration from "./DesktopDataMigration.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/Threadlines.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/Threadlines.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeMigrationLayer = (
  homeDirectory: string,
  env: Record<string, string | undefined> = {},
) => {
  const environmentLayer = DesktopEnvironment.layer({
    ...defaultInput,
    homeDirectory,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest(env))));

  return Layer.mergeAll(NodeServices.layer, environmentLayer);
};

const runMigration = (homeDirectory: string, env: Record<string, string | undefined> = {}) =>
  DesktopDataMigration.migrateLegacyDesktopData().pipe(
    Effect.provide(makeMigrationLayer(homeDirectory, env)),
  );

describe("DesktopDataMigration", () => {
  it.effect("copies legacy .badcode data into the default .threadlines directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-legacy-data-migration-",
      });
      const legacyThreadPath = path.join(
        homeDirectory,
        ".badcode",
        "userdata",
        "threads",
        "thread.json",
      );

      yield* fileSystem.makeDirectory(path.dirname(legacyThreadPath), { recursive: true });
      yield* fileSystem.writeFileString(legacyThreadPath, "legacy-thread");

      const status = yield* runMigration(homeDirectory);

      assert.equal(status, "migrated");
      assert.equal(
        yield* fileSystem.readFileString(
          path.join(homeDirectory, ".threadlines", "userdata", "threads", "thread.json"),
        ),
        "legacy-thread",
      );
      assert.isTrue(yield* fileSystem.exists(legacyThreadPath));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to legacy .t3 data when .badcode is missing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-t3-data-migration-",
      });

      yield* fileSystem.makeDirectory(path.join(homeDirectory, ".t3", "userdata"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        path.join(homeDirectory, ".t3", "userdata", "settings.json"),
        "legacy-settings",
      );

      const status = yield* runMigration(homeDirectory);

      assert.equal(status, "migrated");
      assert.equal(
        yield* fileSystem.readFileString(
          path.join(homeDirectory, ".threadlines", "userdata", "settings.json"),
        ),
        "legacy-settings",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses an empty .threadlines directory as a safe migration target", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-empty-target-migration-",
      });

      yield* fileSystem.makeDirectory(path.join(homeDirectory, ".threadlines"), {
        recursive: true,
      });
      yield* fileSystem.makeDirectory(path.join(homeDirectory, ".badcode", "userdata"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        path.join(homeDirectory, ".badcode", "userdata", "settings.json"),
        "legacy-settings",
      );

      const status = yield* runMigration(homeDirectory);

      assert.equal(status, "migrated");
      assert.equal(
        yield* fileSystem.readFileString(
          path.join(homeDirectory, ".threadlines", "userdata", "settings.json"),
        ),
        "legacy-settings",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not overwrite an existing .threadlines directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-existing-target-migration-",
      });

      yield* fileSystem.makeDirectory(path.join(homeDirectory, ".badcode", "userdata"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        path.join(homeDirectory, ".badcode", "userdata", "settings.json"),
        "legacy-settings",
      );
      yield* fileSystem.makeDirectory(path.join(homeDirectory, ".threadlines", "userdata"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        path.join(homeDirectory, ".threadlines", "userdata", "settings.json"),
        "current-settings",
      );

      const status = yield* runMigration(homeDirectory);

      assert.equal(status, "skipped-existing-threadlines-dir");
      assert.equal(
        yield* fileSystem.readFileString(
          path.join(homeDirectory, ".threadlines", "userdata", "settings.json"),
        ),
        "current-settings",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("skips migration when the user configured a custom Threadlines home", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-custom-home-migration-",
      });

      yield* fileSystem.makeDirectory(path.join(homeDirectory, ".badcode", "userdata"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        path.join(homeDirectory, ".badcode", "userdata", "settings.json"),
        "legacy-settings",
      );

      const status = yield* runMigration(homeDirectory, {
        BADCODE_HOME: path.join(homeDirectory, "custom-compat-home"),
      });

      assert.equal(status, "skipped-custom-base-dir");
      assert.isFalse(yield* fileSystem.exists(path.join(homeDirectory, ".threadlines")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
