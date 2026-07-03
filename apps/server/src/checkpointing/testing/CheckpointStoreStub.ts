/**
 * CheckpointStoreStub - Test double factory for CheckpointStoreShape.
 *
 * Provides benign defaults for every checkpoint operation so tests only
 * declare the behaviors they exercise and new service methods do not break
 * unrelated suites.
 *
 * @module CheckpointStoreStub
 */
import * as Effect from "effect/Effect";

import type { CheckpointStoreShape } from "../Services/CheckpointStore.ts";

export function makeCheckpointStoreStub(
  overrides: Partial<CheckpointStoreShape> = {},
): CheckpointStoreShape {
  return {
    isGitRepository: () => Effect.succeed(true),
    captureCheckpoint: () => Effect.void,
    hasCheckpointRef: () => Effect.succeed(false),
    restoreCheckpoint: () => Effect.succeed(true),
    resolveCheckpointCommit: () => Effect.succeed(null),
    diffCheckpoints: () => Effect.succeed(""),
    diffCheckpointEntries: () => Effect.succeed([]),
    hashWorktreePaths: () => Effect.succeed([]),
    restoreCheckpointPaths: () => Effect.void,
    restoreCheckpointFileEdits: () => Effect.succeed(false),
    deleteCheckpointRefs: () => Effect.void,
    ...overrides,
  };
}
