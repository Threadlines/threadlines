/**
 * CheckpointRevert - Revert planning and execution for thread checkpoints.
 *
 * Owns the shared core behind "Revert to this message": resolving the revert
 * context (workspace, isolation mode, target checkpoint), computing a dry-run
 * plan for preview, and applying the revert. The orchestration reactor uses
 * it to execute reverts; the WebSocket API uses it to serve revert previews.
 *
 * @module CheckpointRevert
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  CheckpointRef,
  OrchestrationGetRevertPlanInput,
  OrchestrationGetRevertPlanResult,
  OrchestrationThread,
  ThreadId,
} from "@threadlines/contracts";
import type { CheckpointServiceError } from "../Errors.ts";
import type { SelectiveRevertConflict } from "../SelectiveRevert.ts";

export interface ResolveRevertContextInput {
  readonly threadId: ThreadId;
  readonly turnCount: number;
}

export interface CheckpointRevertContext {
  readonly threadId: ThreadId;
  readonly turnCount: number;
  readonly currentTurnCount: number;
  /** Workspace directory the revert operates on. */
  readonly cwd: string;
  /** False when the cwd came from thread/project config instead of a live session. */
  readonly hasProviderSession: boolean;
  /** "workspace" restores the whole checkout; "selective" only thread-owned bytes. */
  readonly mode: "workspace" | "selective";
  readonly targetCheckpointRef: CheckpointRef;
  readonly thread: OrchestrationThread;
}

export type CheckpointRevertContextResult =
  | { readonly kind: "ready"; readonly context: CheckpointRevertContext }
  | { readonly kind: "unavailable"; readonly detail: string };

export interface SelectiveRevertOutcome {
  readonly mode: "selective";
  /** Paths that were (or on a dry run, would be) reverted. */
  readonly revertedPaths: ReadonlyArray<string>;
  /** Total files brought back to the target state (exact, hunk, and turn-level). */
  readonly revertedFileCount: number;
  /** Subset of revertedFileCount restored via hunk-level inverse patch. */
  readonly hunkRevertedFileCount: number;
  /** Subset of revertedFileCount restored via turn-by-turn rollback. */
  readonly interleavedRevertedFileCount: number;
  readonly conflicts: ReadonlyArray<SelectiveRevertConflict>;
  readonly unattributedPathCount: number;
  readonly noopPathCount: number;
  readonly skippedReason?: "missing-latest-checkpoint";
}

export type RevertFileOutcome = { readonly mode: "workspace" } | SelectiveRevertOutcome;

/**
 * CheckpointRevertShape - Service API for revert previews and execution.
 */
export interface CheckpointRevertShape {
  /**
   * Resolve everything a revert needs: workspace cwd (live session or
   * thread/project fallback), isolation mode, and the target checkpoint.
   * Returns an explanation instead of failing when the revert cannot run.
   */
  readonly resolveContext: (
    input: ResolveRevertContextInput,
  ) => Effect.Effect<CheckpointRevertContextResult, CheckpointServiceError>;

  /**
   * Compute the revert outcome without touching the workspace. Hunk-level and
   * turn-level candidates are fully verified via dry-run merges, so the plan
   * matches what applyRevert would do barring concurrent writes.
   *
   * Returns null when the target checkpoint cannot be resolved.
   */
  readonly planRevert: (
    context: CheckpointRevertContext,
  ) => Effect.Effect<RevertFileOutcome | null, CheckpointServiceError>;

  /**
   * Apply the revert to the workspace and report what happened.
   *
   * Returns null when the target checkpoint cannot be resolved.
   */
  readonly applyRevert: (
    context: CheckpointRevertContext,
  ) => Effect.Effect<RevertFileOutcome | null, CheckpointServiceError>;

  /**
   * Resolve, plan, and map a revert preview to its wire shape for the API.
   *
   * Fails with CheckpointUnavailableError when the revert cannot run.
   */
  readonly getRevertPlan: (
    input: OrchestrationGetRevertPlanInput,
  ) => Effect.Effect<OrchestrationGetRevertPlanResult, CheckpointServiceError>;
}

/**
 * CheckpointRevert - Service tag for revert planning and execution.
 */
export class CheckpointRevert extends Context.Service<CheckpointRevert, CheckpointRevertShape>()(
  "threadlines/checkpointing/Services/CheckpointRevert",
) {}
