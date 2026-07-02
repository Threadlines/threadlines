/**
 * CheckpointStoreLive - Filesystem checkpoint store adapter layer.
 *
 * Resolves the active VCS driver once per checkpoint operation and delegates
 * checkpoint-specific behavior to the driver's optional checkpoint capability.
 *
 * @module CheckpointStoreLive
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { VcsUnsupportedOperationError } from "@threadlines/contracts";
import { VcsDriverRegistry } from "../../vcs/VcsDriverRegistry.ts";
import type { VcsCheckpointOps } from "../../vcs/VcsDriver.ts";

const makeCheckpointStore = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry;

  const resolveCheckpoints = Effect.fn("CheckpointStore.resolveCheckpoints")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* vcsRegistry.resolve({ cwd });
    if (!handle.driver.checkpoints) {
      return yield* new VcsUnsupportedOperationError({
        operation,
        kind: handle.kind,
        detail: `${handle.kind} driver does not implement checkpoint operations.`,
      });
    }
    return handle.driver.checkpoints satisfies VcsCheckpointOps;
  });

  const isGitRepository: CheckpointStoreShape["isGitRepository"] = (cwd) =>
    vcsRegistry.resolve({ cwd, requestedKind: "git" }).pipe(
      Effect.map(() => true),
      Effect.catch(() => Effect.succeed(false)),
    );

  const captureCheckpoint: CheckpointStoreShape["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.captureCheckpoint", input.cwd);
    return yield* checkpoints.captureCheckpoint(input);
  });

  const hasCheckpointRef: CheckpointStoreShape["hasCheckpointRef"] = Effect.fn("hasCheckpointRef")(
    function* (input) {
      const checkpoints = yield* resolveCheckpoints("CheckpointStore.hasCheckpointRef", input.cwd);
      return yield* checkpoints.hasCheckpointRef(input);
    },
  );

  const restoreCheckpoint: CheckpointStoreShape["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.restoreCheckpoint", input.cwd);
    return yield* checkpoints.restoreCheckpoint(input);
  });

  const resolveCheckpointCommit: CheckpointStoreShape["resolveCheckpointCommit"] = Effect.fn(
    "resolveCheckpointCommit",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(
      "CheckpointStore.resolveCheckpointCommit",
      input.cwd,
    );
    return yield* checkpoints.resolveCheckpointCommit(input);
  });

  const diffCheckpoints: CheckpointStoreShape["diffCheckpoints"] = Effect.fn("diffCheckpoints")(
    function* (input) {
      const checkpoints = yield* resolveCheckpoints("CheckpointStore.diffCheckpoints", input.cwd);
      return yield* checkpoints.diffCheckpoints(input);
    },
  );

  const diffCheckpointEntries: CheckpointStoreShape["diffCheckpointEntries"] = Effect.fn(
    "diffCheckpointEntries",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(
      "CheckpointStore.diffCheckpointEntries",
      input.cwd,
    );
    return yield* checkpoints.diffCheckpointEntries(input);
  });

  const hashWorktreePaths: CheckpointStoreShape["hashWorktreePaths"] = Effect.fn(
    "hashWorktreePaths",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.hashWorktreePaths", input.cwd);
    return yield* checkpoints.hashWorktreePaths(input);
  });

  const restoreCheckpointPaths: CheckpointStoreShape["restoreCheckpointPaths"] = Effect.fn(
    "restoreCheckpointPaths",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(
      "CheckpointStore.restoreCheckpointPaths",
      input.cwd,
    );
    return yield* checkpoints.restoreCheckpointPaths(input);
  });

  const restoreCheckpointFileHunks: CheckpointStoreShape["restoreCheckpointFileHunks"] = Effect.fn(
    "restoreCheckpointFileHunks",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(
      "CheckpointStore.restoreCheckpointFileHunks",
      input.cwd,
    );
    return yield* checkpoints.restoreCheckpointFileHunks(input);
  });

  const deleteCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(
      "CheckpointStore.deleteCheckpointRefs",
      input.cwd,
    );
    return yield* checkpoints.deleteCheckpointRefs(input);
  });

  return {
    isGitRepository,
    captureCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    resolveCheckpointCommit,
    diffCheckpoints,
    diffCheckpointEntries,
    hashWorktreePaths,
    restoreCheckpointPaths,
    restoreCheckpointFileHunks,
    deleteCheckpointRefs,
  } satisfies CheckpointStoreShape;
});

export const CheckpointStoreLive = Layer.effect(CheckpointStore, makeCheckpointStore);
