import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as PreviewProfiles from "./PreviewProfiles.ts";
import * as PreviewSession from "./PreviewSession.ts";
import { LEGACY_PREVIEW_PARTITION, previewProfilePartition } from "./previewPartitions.ts";

const environmentId = EnvironmentId.make("environment-1");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

/** Records what was cleared; partitions listed in `failing` fail to clear. */
function makePreviewSession(
  failing: ReadonlySet<string> = new Set(),
  stored: ReadonlyArray<string> = [],
) {
  const cleared: string[] = [];
  const shape: PreviewSession.PreviewSessionShape = {
    getSession: () => Effect.die("unexpected getSession"),
    clearCache: () => Effect.die("unexpected clearCache"),
    clearBrowsingData: () => Effect.die("unexpected clearBrowsingData"),
    storedPartitions: Effect.succeed(stored),
    clearAllData: (partition) =>
      failing.has(partition)
        ? Effect.fail(new PreviewSession.PreviewSessionCreationError({ partition, cause: null }))
        : Effect.sync(() => {
            cleared.push(partition);
          }),
  };
  return { cleared, layer: Layer.succeed(PreviewSession.PreviewSession, shape) };
}

function makeLayer(baseDir: string, previewSession: Layer.Layer<PreviewSession.PreviewSession>) {
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
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
  return PreviewProfiles.layer.pipe(
    Layer.provide(previewSession),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

const withTempDir = <A, E, R>(use: (baseDir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "threadlines-preview-profiles-test-",
    });
    return yield* use(baseDir);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const listPartitions = Effect.gen(function* () {
  const profiles = yield* PreviewProfiles.PreviewProfiles;
  return (yield* profiles.list).map((profile) => profile.partition).toSorted();
});

describe("PreviewProfiles", () => {
  it.effect("remembers every partition it hands out, across restarts", () =>
    withTempDir((baseDir) =>
      Effect.gen(function* () {
        const session = makePreviewSession();
        const partitionA = previewProfilePartition(environmentId, projectA);
        const partitionB = previewProfilePartition(environmentId, projectB);

        yield* Effect.gen(function* () {
          const profiles = yield* PreviewProfiles.PreviewProfiles;
          assert.equal(
            yield* profiles.partitionFor({ environmentId, projectId: projectA }),
            partitionA,
          );
          assert.equal(
            yield* profiles.partitionFor({ environmentId, projectId: projectB }),
            partitionB,
          );
          // Asking again refreshes the entry rather than adding a second one.
          yield* profiles.partitionFor({ environmentId, projectId: projectA });
        }).pipe(Effect.provide(makeLayer(baseDir, session.layer)));

        const reloaded = yield* Effect.gen(function* () {
          const profiles = yield* PreviewProfiles.PreviewProfiles;
          return yield* profiles.list;
        }).pipe(Effect.provide(makeLayer(baseDir, session.layer)));

        assert.deepEqual(
          reloaded
            .map(({ partition, environmentId, projectId }) => ({
              partition,
              environmentId,
              projectId,
            }))
            .toSorted((left, right) => left.projectId.localeCompare(right.projectId)),
          [
            { partition: partitionA, environmentId, projectId: projectA },
            { partition: partitionB, environmentId, projectId: projectB },
          ],
        );
        assert.deepEqual(session.cleared, []);
      }),
    ),
  );

  it.effect("forgets a profile only once its data is cleared", () =>
    withTempDir((baseDir) =>
      Effect.gen(function* () {
        const partitionA = previewProfilePartition(environmentId, projectA);
        const partitionB = previewProfilePartition(environmentId, projectB);
        const session = makePreviewSession(new Set([partitionB]));
        const layer = makeLayer(baseDir, session.layer);

        yield* Effect.gen(function* () {
          const profiles = yield* PreviewProfiles.PreviewProfiles;
          yield* profiles.partitionFor({ environmentId, projectId: projectA });
          yield* profiles.partitionFor({ environmentId, projectId: projectB });

          yield* profiles.forget(partitionA);
          const failed = yield* Effect.flip(profiles.forget(partitionB));
          assert.equal(failed._tag, "PreviewSessionCreationError");
        }).pipe(Effect.provide(layer));

        // Still listed after a restart, so it can be found and cleared later.
        assert.deepEqual(yield* listPartitions.pipe(Effect.provide(layer)), [partitionB]);
        assert.deepEqual(session.cleared, [partitionA]);
      }),
    ),
  );

  it.effect("clears every profile and the old shared one, past a failure", () =>
    withTempDir((baseDir) =>
      Effect.gen(function* () {
        const partitionA = previewProfilePartition(environmentId, projectA);
        const partitionB = previewProfilePartition(environmentId, projectB);
        // On disk from an earlier run whose record was never written.
        const unrecorded = previewProfilePartition(environmentId, ProjectId.make("project-c"));
        const session = makePreviewSession(new Set([partitionA]), [unrecorded, partitionB]);

        yield* Effect.gen(function* () {
          const profiles = yield* PreviewProfiles.PreviewProfiles;
          yield* profiles.partitionFor({ environmentId, projectId: projectA });
          yield* profiles.partitionFor({ environmentId, projectId: projectB });

          const failed = yield* Effect.flip(profiles.clearAll);
          assert.deepEqual(failed.partitions, [partitionA]);
          // Clearing is not forgetting: the profiles still exist.
          assert.deepEqual(yield* listPartitions, [partitionA, partitionB].toSorted());
        }).pipe(Effect.provide(makeLayer(baseDir, session.layer)));

        assert.deepEqual(session.cleared, [LEGACY_PREVIEW_PARTITION, partitionB, unrecorded]);
      }),
    ),
  );
});
