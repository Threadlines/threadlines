/**
 * CheckpointDiffQuery - Query interface for computed checkpoint diffs.
 *
 * Provides read-only diff operations across checkpoint snapshots used by
 * orchestration APIs.
 *
 * @module CheckpointDiffQuery
 */
import type {
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationGetTurnFileInput,
  OrchestrationGetTurnFileResult,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { CheckpointServiceError } from "../Errors.ts";

/**
 * CheckpointDiffQueryShape - Service API for checkpoint diff queries.
 */
export interface CheckpointDiffQueryShape {
  /**
   * Read the patch diff for a single turn checkpoint transition.
   *
   * Verifies checkpoint availability in both projection state and filesystem.
   */
  readonly getTurnDiff: (
    input: OrchestrationGetTurnDiffInput,
  ) => Effect.Effect<OrchestrationGetTurnDiffResult, CheckpointServiceError>;

  /**
   * Read the full patch diff across a thread range of checkpoints.
   *
   * Delegates to turn diff with `fromTurnCount = 0`.
   */
  readonly getFullThreadDiff: (
    input: OrchestrationGetFullThreadDiffInput,
  ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;

  /**
   * One file of the thread's change, as the snapshot on either side of a
   * range holds it: the same snapshots `getTurnDiff` (a `turn` range) and
   * `getFullThreadDiff` (a `thread` range) compare. Only files the range's
   * turns changed are read; any other path is `missing`.
   */
  readonly getTurnFile: (
    input: OrchestrationGetTurnFileInput,
  ) => Effect.Effect<OrchestrationGetTurnFileResult, CheckpointServiceError>;
}

/**
 * CheckpointDiffQuery - Service tag for checkpoint diff queries.
 */
export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  CheckpointDiffQueryShape
>()("threadlines/checkpointing/Services/CheckpointDiffQuery") {}
