/**
 * What the move checks (threadMoveRefusals) read about one thread, and no
 * more: the thread, the threads that could hold its move (its attached
 * children, and threads working in the same checkout), and their projects.
 * Loading the whole command read model for this costs about half a second
 * on an install with 3,000 threads; this costs a few milliseconds.
 */
import type {
  OrchestrationProjectShell,
  OrchestrationThread,
  ThreadId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ThreadMoveView } from "../orchestration/threadMoveDecisions.ts";

export interface ThreadMoveContext {
  readonly thread: OrchestrationThread;
  readonly view: ThreadMoveView;
}

/**
 * Reads one thread's move context; null when the thread is gone. Archived
 * threads are read too: a move runs on while its thread is archived.
 */
export const makeThreadMoveContextReader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const snapshots = yield* ProjectionSnapshotQuery;

  const projectOf = (projectId: OrchestrationThread["projectId"]) =>
    snapshots.getProjectShellById(projectId).pipe(Effect.map(Option.getOrUndefined));

  return (threadId: ThreadId) =>
    Effect.gen(function* () {
      const found = yield* snapshots.getThreadDetailById(threadId, { includeArchived: true });
      if (Option.isNone(found)) return null;
      const thread = found.value;
      const project = yield* projectOf(thread.projectId);
      // A general chat works in a folder of its own: it shares no checkout.
      const checkout =
        project?.kind === "general-chat"
          ? null
          : (thread.worktreePath ?? project?.workspaceRoot ?? null);
      // Its attached children, and every other thread in the same checkout.
      const neighbors = yield* sql<{ readonly threadId: ThreadId }>`
        SELECT t.thread_id AS "threadId"
        FROM projection_threads t
        LEFT JOIN projection_projects p ON p.project_id = t.project_id
        WHERE t.deleted_at IS NULL
          AND t.thread_id <> ${threadId}
          AND (
            (t.parent_thread_id = ${threadId} AND t.attached_to_parent = 1)
            OR COALESCE(t.worktree_path, p.workspace_root) = ${checkout}
          )
      `;
      const threads: OrchestrationThread[] = [thread];
      for (const row of neighbors) {
        const neighbor = yield* snapshots.getThreadDetailById(row.threadId, {
          includeArchived: true,
        });
        if (Option.isSome(neighbor)) threads.push(neighbor.value);
      }
      const projects: OrchestrationProjectShell[] = [];
      for (const projectId of new Set(threads.map((entry) => entry.projectId))) {
        const shell = projectId === thread.projectId ? project : yield* projectOf(projectId);
        if (shell !== undefined) projects.push(shell);
      }
      return { thread, view: { projects, threads } } satisfies ThreadMoveContext;
    });
});
