/**
 * SubagentWorktreeFollower - service interface for following subagent checkouts.
 *
 * When a session spawns an isolated subagent, the real work moves to a git
 * worktree the session itself never enters. This service infers that move and
 * records it as the thread's effective cwd, so the surfaces that already
 * follow `effectiveCwd` (the "working in ..." chip, the source control panel)
 * point at where the work is actually happening.
 *
 * @module SubagentWorktreeFollower
 */
import type { ThreadId } from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface SubagentWorktreeFollowerShape {
  /**
   * Note that an agent task started, and begin resolving where it runs.
   *
   * Returns as soon as the lookup is scheduled: the provider writes the
   * subagent's checkout record shortly *after* the task starts, so resolution
   * is retried in the background and must never delay event ingestion.
   */
  readonly observeAgentTaskStarted: (input: {
    readonly threadId: ThreadId;
    readonly taskId: string;
    readonly toolUseId: string;
  }) => Effect.Effect<void>;

  /**
   * Note that a task is no longer running. Safe to call for tasks that were
   * never agent tasks; unknown ids are ignored.
   */
  readonly observeTaskEnded: (input: {
    readonly threadId: ThreadId;
    readonly taskId: string;
  }) => Effect.Effect<void>;

  /**
   * Note that a thread's session stopped or restarted, dropping everything
   * inferred for it. Nothing survives a session boundary: the provider's tasks
   * are gone with the process.
   */
  readonly observeSessionEnded: (input: { readonly threadId: ThreadId }) => Effect.Effect<void>;
}

export class SubagentWorktreeFollower extends Context.Service<
  SubagentWorktreeFollower,
  SubagentWorktreeFollowerShape
>()("threadlines/orchestration/SubagentWorktreeFollower") {}
