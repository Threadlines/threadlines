import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as VcsProjectConfig from "./VcsProjectConfig.ts";

const TestLayer = VcsProjectConfig.layer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provideMerge(NodeServices.layer),
);

describe("VcsProjectConfig", () => {
  it.layer(TestLayer)("uses an explicit requested VCS kind before config", (it) => {
    it.effect("returns the requested kind", () =>
      Effect.gen(function* () {
        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({
          cwd: "/repo",
          requestedKind: "jj",
        });

        assert.equal(kind, "jj");
      }),
    );
  });

  it.layer(TestLayer)("discovers .threadlines/vcs.json from nested workspaces", (it) => {
    it.effect("returns the configured kind", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "threadlines-vcs-config-test-",
        });
        const configDir = path.join(root, ".threadlines");
        const nested = path.join(root, "packages", "app");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({ vcs: { kind: "jj" } }),
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: nested });

        assert.equal(kind, "jj");
      }),
    );
  });

  it.layer(TestLayer)("prefers the nearest vcs.json", (it) => {
    it.effect("uses a nested workspace's config over the repository root's", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "threadlines-vcs-config-test-",
        });
        const nested = path.join(root, "packages", "app");
        const writeConfig = (directory: string, kind: string) =>
          fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(
              Effect.andThen(
                fileSystem.writeFileString(
                  path.join(directory, "vcs.json"),
                  JSON.stringify({ vcs: { kind } }),
                ),
              ),
            );
        yield* writeConfig(path.join(root, ".threadlines"), "jj");
        yield* writeConfig(path.join(nested, ".t3code"), "git");

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: nested });

        assert.equal(kind, "git");
      }),
    );
  });

  // A check further up that never answers (an unreachable network mount)
  // must not hold back the nearer config that exists.
  it.layer(
    VcsProjectConfig.layer.pipe(
      Layer.provide(
        FileSystem.layerNoop({
          exists: (candidate) =>
            candidate === "/repo/packages/app/.t3code/vcs.json"
              ? Effect.succeed(true)
              : candidate === "/repo/.threadlines/vcs.json"
                ? Effect.never
                : Effect.succeed(false),
          readFileString: () => Effect.succeed('{"vcs":{"kind":"git"}}'),
        }),
      ),
      Layer.provide(NodeServices.layer),
    ),
  )("answers once the nearest config is known", (it) => {
    it.effect("doesn't wait on a stalled check further up", () =>
      Effect.gen(function* () {
        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: "/repo/packages/app" });

        assert.equal(kind, "git");
      }),
    );
  });

  it.layer(TestLayer)("falls back to legacy .t3code/vcs.json", (it) => {
    it.effect("returns the configured kind", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "threadlines-vcs-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        const nested = path.join(root, "packages", "app");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({ vcs: { kind: "jj" } }),
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: nested });

        assert.equal(kind, "jj");
      }),
    );
  });

  it.layer(TestLayer)("falls back to auto when no config exists", (it) => {
    it.effect("returns auto", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "threadlines-vcs-config-test-",
        });
        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: root });

        assert.equal(kind, "auto");
      }),
    );
  });
});
